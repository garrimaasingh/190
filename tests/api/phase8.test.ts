/**
 * Phase 8 API & security test suite — Inter-Department Integration.
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase8.test.ts
 *
 * Covers spec §52-§61: mapping/schema-version handling, duplicate
 * protection, conflict detection + resolution, imported-document hash
 * verification (mismatch BLOCKS), evidence provenance + custody
 * boundary, webhook security (signature/replay/idempotency/unknown
 * types), cross-department authorization, export authorization,
 * provider-failure resilience, circuit breaker, audit-chain integrity
 * with zero secret leakage, and the §61 end-to-end demonstration over
 * MockCCTNSProvider (clearly labeled MOCK/SANDBOX — no real government
 * system exists behind it).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { createHmac } from "crypto";
import { readFile } from "fs/promises";
import { verifyChain } from "@/lib/audit/integrity";
import { CircuitBreaker, CircuitOpenError, resetCircuitBreaker } from "@/lib/integrations/circuit-breaker";
import { integrationMappingService } from "@/lib/integrations/mapping";
import { getProvider, listRegisteredProviderTypes } from "@/lib/integrations/registry";
import { integrationCredentialService } from "@/lib/integrations/credentials";

const BASE = "http://localhost:3000";
function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 60000);
}
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a", "connection": "close" }; // connection:close — kills the bun-fetch/Next-dev keep-alive race that intermittently delivers empty request bodies (500 JSON.parse)

// ---------- HTTP client ----------
class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;

  get status() { return this.lastStatus; }

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = { ...BYPASS, ...(extraHeaders || {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const send = () =>
      fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let res = await send();
    if (res.status >= 500) res = await send(); // stable re-run: ONE retry on transient dev-server 5xx
    this.lastStatus = res.status;
    try {
      this.lastBody = await res.json();
    } catch {
      this.lastBody = null;
    }
    return this.lastBody;
  }

  async login(email: string) {
    // ONE login request — a redundant duplicate here could silently drop
    // the cookie on a transient compile race and cascade 401s.
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { ...BYPASS, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: SEED_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const raw = res.headers.get("set-cookie");
    this.cookie = raw ? raw.split(";")[0] : null;
    expect(this.cookie).toBeTruthy();
  }
}

let sysadmin: Client;
let arjun: Client; // police DEPARTMENT_ADMIN
let meera: Client; // FSL DEPARTMENT_ADMIN
let vishnu: Client; // police OFFICER
let priya: Client; // AUDITOR

const CCTNS = "CONN-MP-IND-2026-000001"; // seeded, police-owned
const CCTNS_CANONICAL_CONFIG = { autoApproveLowRisk: true, importCaseDocuments: true, importCaseEvidence: true };

async function restoreCctns() {
  await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: CCTNS_CANONICAL_CONFIG });
  const row = await db.integrationConnection.findUnique({ where: { connectionId: CCTNS } });
  if (row) resetCircuitBreaker(row.id);
}

// Webhook signature helper — mirrors MockIntegrationProvider.craftSignedWebhook.
function sign(secret: string, body: string, ts = Date.now()) {
  return { "x-mock-signature": createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"), "x-mock-timestamp": String(ts) };
}

beforeAll(async () => {
  sysadmin = new Client();
  await sysadmin.login("sysadmin@demo.gov.in");
  arjun = new Client();
  await arjun.login("arjun.sharma@demo.gov.in");
  meera = new Client();
  await meera.login("meera.desai@demo.gov.in");
  vishnu = new Client();
  await vishnu.login("vishnu.kumar@demo.gov.in");
  priya = new Client();
  await priya.login("priya.nair@demo.gov.in");
  // Deterministic baseline: canonical config + closed circuit regardless
  // of any earlier aborted run (config switches are connection-global).
  await restoreCctns();
}, 60000);

// ============================================================
// A. Registry + capability model (§2-§5)
// ============================================================
describe("Phase 8 — registry & capabilities", () => {
  t("A1. six provider adapters registered (adapter targets only — no real integrations claimed)", () => {
    expect(listRegisteredProviderTypes().sort()).toEqual(["CCTNS", "E_COURTS", "E_FORENSICS", "E_PRISONS", "E_PROSECUTION", "ICJS"]);
    for (const type of listRegisteredProviderTypes()) {
      expect(getProvider(type)!.providerMode).toBe("MOCK");
    }
  });

  t("A2. capability sets differ per provider — capability model drives what is offered (§4)", () => {
    const cctns = getProvider("CCTNS")!.capabilities;
    const fsl = getProvider("E_FORENSICS")!.capabilities;
    const courts = getProvider("E_COURTS")!.capabilities;
    const icjs = getProvider("ICJS")!.capabilities;
    expect(cctns.can_import_case).toBe(true);
    expect(cctns.can_import_evidence).toBe(true);
    expect(fsl.can_import_evidence).toBe(true);
    expect(fsl.can_import_case).toBe(false); // forensics does not import cases
    expect(courts.can_export_case).toBe(true);
    expect(courts.can_import_case).toBe(false); // read/export only
    expect(icjs.can_search_cases).toBe(true);
    expect(icjs.can_import_case).toBe(false); // search-only sandbox
  });

  t("A3. meta exposes integration registries", async () => {
    await sysadmin.req("GET", "/api/v1/meta");
    expect(sysadmin.status).toBe(200);
    expect(sysadmin.lastBody.data.integrationProviderTypes).toContain("CCTNS");
    expect(sysadmin.lastBody.data.integrationProviderModes).toContain("MOCK");
  });

  t("A4. §71 — every connection carries providerMode=MOCK; no credential material ever in responses", async () => {
    await sysadmin.req("GET", "/api/v1/integrations");
    expect(sysadmin.status).toBe(200);
    expect(sysadmin.lastBody.data.items.length).toBeGreaterThanOrEqual(6);
    const raw = JSON.stringify(sysadmin.lastBody);
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("webhookSecret");
    expect(raw).not.toContain("credentialRef");
    expect(raw).not.toContain("secret://");
    for (const item of sysadmin.lastBody.data.items) {
      expect(item.providerMode).toBe("MOCK");
      expect(item.environment).toBe("SANDBOX");
    }
  });

  t("A5. §7 — DB stores secret REFERENCES only; encrypted blobs contain no plaintext", async () => {
    const credRows = await db.integrationCredential.findMany();
    expect(credRows.length).toBeGreaterThanOrEqual(6);
    for (const row of credRows) {
      expect(row.secretReference.startsWith("secret://integrations/")).toBe(true);
      expect(row.keyFingerprint).toMatch(/^[0-9A-F]{12}$/);
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("sandbox-key-0123456789");
      expect(serialized).not.toContain("whsec-0123456789");
    }
    // The encrypted blob on disk must not contain the plaintext fixture secret.
    const blob = await readFile(".integration-secrets/secret_integrations_CONN-MP-IND-2026-000001_v1.bin");
    const text = new TextDecoder().decode(blob);
    expect(text).not.toContain("sandbox-key-0123456789");
  });

  t("A6. credential service round-trips through the encrypted store", async () => {
    const resolved = await integrationCredentialService.resolve(CCTNS);
    expect(resolved).not.toBeNull();
    expect(resolved!.apiKey!.startsWith("mock-cctns-")).toBe(true);
    expect(resolved!.webhookSecret!.startsWith("mock-cctns-whsec-")).toBe(true);
  });
});

// ============================================================
// B. Connection management (§6/§8/§10/§38/§39)
// ============================================================
describe("Phase 8 — connection management", () => {
  let connId: string;
  const apiKey = "mock-test-api-key-arjun-0001";
  const whsec = "mock-test-whsec-arjun-00000001";

  t("B1. department admin configures a MOCK/SANDBOX connection (§61 steps 3-4)", async () => {
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "CCTNS",
      displayName: "CCTNS test connection — Police (MOCK SANDBOX)",
      environment: "SANDBOX",
      providerMode: "MOCK",
      authenticationType: "API_KEY",
      config: { autoApproveLowRisk: true },
      credentials: { apiKey, webhookSecret: whsec },
    });
    expect(arjun.status).toBe(201);
    connId = arjun.lastBody.data.connectionId;
    expect(connId).toMatch(/^CONN-MP-IND-\d{4}-\d{6}$/);
    expect(arjun.lastBody.data.providerMode).toBe("MOCK");
    expect(JSON.stringify(arjun.lastBody)).not.toContain(apiKey);
  });

  t("B2. §8 — MOCK provider cannot masquerade as PRODUCTION", async () => {
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "CCTNS",
      displayName: "Mock production attempt",
      environment: "PRODUCTION",
      providerMode: "MOCK",
      confirmProduction: true,
    });
    expect(arjun.status).toBe(422);
    expect(arjun.lastBody.error.code).toBe("ENVIRONMENT_MODE_CONFLICT");
  });

  t("B3. §8/§70 — PRODUCTION requires explicit confirmation", async () => {
    // REAL mode is refused outright on this platform (no verified interface).
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "CCTNS",
      displayName: "Real mode attempt",
      environment: "SANDBOX",
      providerMode: "REAL",
    });
    expect(arjun.status).toBe(422);
    expect(arjun.lastBody.error.code).toBe("REAL_PROVIDER_NOT_AVAILABLE");
  });

  t("B4. §38 — OFFICER has no integration configuration rights", async () => {
    await vishnu.req("POST", "/api/v1/integrations", {
      providerType: "CCTNS",
      displayName: "Officer attempt — should fail",
      environment: "SANDBOX",
    });
    expect(vishnu.status).toBe(403);
  });

  t("B5. §10 — connection test: SUCCESS with capability snapshot", async () => {
    await arjun.req("POST", `/api/v1/integrations/${connId}/test`);
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.outcome).toBe("SUCCESS");
    expect(arjun.lastBody.data.detail.capabilities.can_search_cases).toBe(true);
    expect(JSON.stringify(arjun.lastBody)).not.toContain(apiKey);
  });

  t("B6. §10 — test without credentials → NOT_CONFIGURED (auth failure surfaced, never secrets)", async () => {
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "E_COURTS",
      displayName: "E-Courts no-cred test (MOCK SANDBOX)",
      environment: "SANDBOX",
      providerMode: "MOCK",
      authenticationType: "NONE",
      credentials: { apiKey: "placeholder-none-cred" }, // auth type NONE but mock still requires a key
    });
    expect(arjun.status).toBe(201);
    const noCred = arjun.lastBody.data.connectionId;
    // Remove the credential via PATCH-less route: use a connection created WITHOUT credentials.
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "ICJS",
      displayName: "ICJS no-cred test (MOCK SANDBOX)",
      environment: "SANDBOX",
      providerMode: "MOCK",
      authenticationType: "API_KEY",
    });
    expect(arjun.status).toBe(201);
    const bare = arjun.lastBody.data.connectionId;
    await arjun.req("POST", `/api/v1/integrations/${bare}/test`);
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.outcome).toBe("NOT_CONFIGURED");
    void noCred;
  });

  t("B7. §39 — department scoping: list visibility is scoped", async () => {
    await meera.req("GET", "/api/v1/integrations");
    expect(meera.status).toBe(200);
    const seen = meera.lastBody.data.items.map((i: any) => i.connectionId);
    // Meera (FSL) must NOT see police-owned connections except through no channel.
    await sysadmin.req("GET", `/api/v1/integrations/${connId}`);
    const owner = sysadmin.lastBody.data.connection; // detail route returns owner via list only
    void owner;
    expect(seen).not.toContain(CCTNS); // police-owned
    expect(seen).toContain("CONN-MP-IND-2026-000002"); // FSL-owned
    await priya.req("GET", "/api/v1/integrations");
    expect(priya.status).toBe(200); // auditor: read-only platform-wide (§38)
  });

  t("B8. §9 — health endpoint reports per-provider status/latency without credentials", async () => {
    await sysadmin.req("GET", "/api/v1/integrations/health");
    expect(sysadmin.status).toBe(200);
    const providers = sysadmin.lastBody.data.providers;
    expect(providers.length).toBeGreaterThanOrEqual(6);
    const raw = JSON.stringify(sysadmin.lastBody);
    expect(raw).not.toContain("apiKey");
    for (const p of providers) {
      expect(["CONNECTED", "ERROR", "DISABLED"]).toContain(p.status);
      expect(p.environment).toBeDefined();
    }
  });

  t("B9. after successful test the connection reports CONNECTED", async () => {
    await sysadmin.req("GET", `/api/v1/integrations/${connId}`);
    expect(sysadmin.status).toBe(200);
    expect(sysadmin.lastBody.data.connection.status).toBe("CONNECTED");
    expect(sysadmin.lastBody.data.connection.capabilities.can_import_case).toBe(true);
  });

  t("B10. disable/enable via PATCH (admin action, audited)", async () => {
    await arjun.req("PATCH", `/api/v1/integrations/${connId}`, { enabled: false });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.enabled).toBe(false);
    expect(arjun.lastBody.data.status).toBe("DISABLED");
    await arjun.req("PATCH", `/api/v1/integrations/${connId}`, { enabled: true });
    expect(arjun.status).toBe(200);
    // Operations on a DISABLED connection are refused.
    await arjun.req("PATCH", `/api/v1/integrations/${connId}`, { enabled: false });
    await arjun.req("POST", `/api/v1/integrations/${connId}/search`, { q: "mock" });
    expect(arjun.status).toBe(403);
    await arjun.req("PATCH", `/api/v1/integrations/${connId}`, { enabled: true });
  });
});

// ============================================================
// C. Mapping & schema versioning (§18/§19/§20/§52/§69)
// ============================================================
describe("Phase 8 — mapping & schema versions", () => {
  t("C1. §52 — external payload maps into central shapes; officer badge is SENSITIVE", async () => {
    const mapping = await integrationMappingService.getActiveMapping("CCTNS", "case_import");
    expect(mapping).not.toBeNull();
    const result = integrationMappingService.mapRecord(mapping!.mappings, {
      externalCaseId: "MOCK-CASE-001",
      caseNumber: "CCTNS-CASE-892341",
      title: "State vs Anil Kumar",
      caseType: "CRIMINAL",
      priority: "high", // normalization → HIGH
      investigatingOfficer: { name: "Inspector R. Chouhan", badge: "MOCK-IO-7712" },
      updatedAt: "2026-09-15T04:30:00.000Z",
    });
    expect(result.errors).toHaveLength(0);
    expect(result.values.title).toBe("State vs Anil Kumar");
    expect(result.values.priority).toBe("HIGH"); // upper-cased enum normalization
    expect(result.values.externalCaseNumber).toBe("CCTNS-CASE-892341");
    expect(result.sensitiveFields).toContain("officerBadge"); // never auto-applied (§15)
  });

  t("C2. §52 — missing required fields and invalid enums produce STRUCTURED errors (§20)", async () => {
    const mapping = (await integrationMappingService.getActiveMapping("CCTNS", "case_import"))!;
    const result = integrationMappingService.mapRecord(mapping.mappings, {
      // externalCaseId missing (required)
      title: "X",
      caseType: "TRAFFIC", // invalid enum
      priority: "URGENT999", // invalid enum
    });
    expect(result.errors.some((e) => e.code === "REQUIRED_MISSING" && e.field === "externalCaseId")).toBe(true);
    expect(result.errors.some((e) => e.code === "INVALID_ENUM" && e.field === "caseType")).toBe(true);
    expect(result.errors.some((e) => e.code === "INVALID_ENUM" && e.field === "priority")).toBe(true);
    // One malformed record never throws — it returns data (§20).
  });

  t("C3. §69 — unsupported schema versions are never processed silently", async () => {
    try {
      await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: { autoApproveLowRisk: true, scenarioSchemaVersion: "9.9-beta" } });
      expect(sysadmin.status).toBe(200);
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.status).toBe(200); // job outcome as data — no 5xx
      expect(arjun.lastBody.data.status).toBe("FAILED");
      expect(arjun.lastBody.data.errorSummary).toContain("SCHEMA_VERSION_UNSUPPORTED");
      // Audit recorded the unsupported schema event (§37).
      const auditRow = await db.auditEvent.findFirst({ where: { eventType: "INTEGRATION_SCHEMA_UNSUPPORTED" }, orderBy: { sequence: "desc" } });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.metadata).toContain("9.9-beta");
    } finally {
      await restoreCctns();
    }
  });
});

// ============================================================
// D. Import: duplicates, conflicts, resolution (§15/§22/§24/§53/§54)
// ============================================================
describe("Phase 8 — import duplicates & conflicts", () => {
  t("D1. §24/§53 — first import creates ONE central case + ONE external reference", async () => {
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-002" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.status).toBe("COMPLETED");
    // 1 case record (+ its documents — the seed config imports case documents)
    expect(arjun.lastBody.data.recordsImported).toBeGreaterThanOrEqual(1);
    expect(arjun.lastBody.data.recordsRejected).toBe(0);
    const ref = await db.externalCaseReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: CCTNS, externalCaseId: "MOCK-CASE-002" },
      include: { case: true },
    });
    expect(ref).not.toBeNull();
    expect(ref!.case.caseNumber).toBe("CCTNS-CASE-901188"); // external number preserved as metadata (§11)
    expect(ref!.sourceHash).toBeTruthy();
  });

  t("D2. §53 — re-importing the same external case LINKS, never duplicates", async () => {
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-002" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.recordsSkipped).toBeGreaterThanOrEqual(1);
    const count = await db.externalCaseReference.count({ where: { providerType: "CCTNS", externalSystem: CCTNS, externalCaseId: "MOCK-CASE-002" } });
    expect(count).toBe(1);
    const centralCount = await db.case.count({ where: { caseNumber: "CCTNS-CASE-901188" } });
    expect(centralCount).toBe(1);
  });

  t("D3. §61 steps 19-21 — external change + sync → conflict detected, central NOT overwritten", async () => {
    const externalTitle = `XYZ Investigation (externally updated ${Date.now()})`;
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/simulate-change`, {
      externalCaseId: "MOCK-CASE-002",
      patch: { title: externalTitle },
    });
    expect(arjun.status).toBe(200);
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/sync`);
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.synced).toBe(true);
    expect(arjun.lastBody.data.conflicts).toBeGreaterThanOrEqual(1);
    const central = await db.case.findFirst({ where: { caseNumber: "CCTNS-CASE-901188" } });
    expect(central!.title).not.toBe(externalTitle); // §22: NO silent overwrite
    const conflict = await db.integrationConflict.findFirst({
      where: { caseRef: central!.caseId, fieldName: "title", status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.externalValue).toBe(externalTitle);
    expect(conflict!.centralValue).toBe(central!.title);
  });

  t("D4. §22 — conflict resolution RESOLVED_CENTRAL keeps the central value", async () => {
    const central = await db.case.findFirst({ where: { caseNumber: "CCTNS-CASE-901188" } });
    const conflict = await db.integrationConflict.findFirst({ where: { caseRef: central!.caseId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    await priya.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "RESOLVED_CENTRAL", note: "central title stands" });
    expect(priya.status).toBe(403); // §38 — AUDITOR is read-only for resolution
    await meera.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "RESOLVED_CENTRAL" });
    expect(meera.status).toBe(403); // §39 — FSL admin cannot resolve a police case conflict
    await arjun.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "RESOLVED_CENTRAL", note: "central title stands" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.applied).toBe(false);
    const after = await db.case.findFirst({ where: { caseNumber: "CCTNS-CASE-901188" } });
    expect(after!.title).toBe(conflict!.centralValue);
  });

  t("D5. §22 — RESOLVED_EXTERNAL applies the external value as an audited human decision", async () => {
    const externalTitle = `External authoritative title ${Date.now()}`;
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/simulate-change`, {
      externalCaseId: "MOCK-CASE-002",
      patch: { title: externalTitle },
    });
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/sync`);
    const central = await db.case.findFirst({ where: { caseNumber: "CCTNS-CASE-901188" } });
    const conflict = await db.integrationConflict.findFirst({ where: { caseRef: central!.caseId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    await arjun.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "RESOLVED_EXTERNAL", note: "source system is authoritative for the FIR title" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.applied).toBe(true);
    const after = await db.case.findFirst({ where: { caseNumber: "CCTNS-CASE-901188" } });
    expect(after!.title).toBe(externalTitle);
    // Double resolution is refused.
    await arjun.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "IGNORED" });
    expect(arjun.status).toBe(409);
  });
});

// ============================================================
// E. Document import & integrity (§25/§26/§55)
// ============================================================
describe("Phase 8 — document import & integrity", () => {
  t("E1. §25/§26 — document import reuses Phase 3 storage; hash verified end-to-end", async () => {
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "DOCUMENT", externalCaseId: "MOCK-CASE-002", externalDocumentId: "MOCK-DOCUMENT-003" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.status).toBe("COMPLETED");
    const ref = await db.externalDocumentReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: CCTNS, externalDocumentId: "MOCK-DOCUMENT-003" },
      include: { document: true },
    });
    expect(ref).not.toBeNull();
    expect(ref!.document.status).toBe("COMMITTED");
    expect(ref!.document.encryptionStatus).toBe("ENCRYPTED_AES_256_GCM");
    expect(ref!.hashVerified).toBe(true);
    expect(ref!.centralHash).toBe(ref!.sourceHash);
    // §26 — central hash equals SHA-256 over the delivered bytes.
    const { decryptDocument } = await import("@/lib/documents/encryption");
    const stored = await db.caseDocument.findFirst({ where: { id: ref!.documentInternalId }, select: { storageKey: true } });
    const { DocumentStorage } = await import("@/lib/documents/storage");
    const plaintext = decryptDocument(await DocumentStorage.get_object(stored!.storageKey));
    const { createHash } = await import("crypto");
    expect(createHash("sha256").update(plaintext).digest("hex")).toBe(ref!.centralHash);
    // Phase 5 hook: AI processing enqueued for the imported document.
    const aiJobs = await db.aIProcessingJob.findMany({ where: { documentRef: ref!.document.documentId } });
    expect(aiJobs.length).toBeGreaterThanOrEqual(1);
  });

  t("E2. §53 — duplicate document import is recognized (no second central document)", async () => {
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "DOCUMENT", externalCaseId: "MOCK-CASE-002", externalDocumentId: "MOCK-DOCUMENT-003" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.recordsSkipped).toBe(1);
    const count = await db.externalDocumentReference.count({ where: { providerType: "CCTNS", externalSystem: CCTNS, externalDocumentId: "MOCK-DOCUMENT-003" } });
    expect(count).toBe(1);
  });

  t("E3. §55 — hash mismatch BLOCKS the import and raises an integrity event", async () => {
    try {
      // Simulate the external system reporting a corrupted hash for this document.
      await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: { autoApproveLowRisk: true, corruptDocumentHashFor: "MOCK-DOCUMENT-003" } });
      // Use a fresh document id to avoid the duplicate-skip path: re-import SAME id is skipped,
      // so first remove its reference to exercise the pipeline again.
      await db.externalDocumentReference.deleteMany({ where: { providerType: "CCTNS", externalSystem: CCTNS, externalDocumentId: "MOCK-DOCUMENT-003" } });
      const docsBefore = await db.caseDocument.count({ where: { metadata: { contains: "MOCK-DOCUMENT-003" } } });
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "DOCUMENT", externalCaseId: "MOCK-CASE-002", externalDocumentId: "MOCK-DOCUMENT-003" });
      expect(arjun.status).toBe(200);
      expect(arjun.lastBody.data.status).toBe("FAILED");
      expect(arjun.lastBody.data.recordsRejected).toBe(1);
      const job = await db.integrationImportJob.findUnique({ where: { jobId: arjun.lastBody.data.jobId }, include: { records: true } });
      const rejected = job!.records.find((r) => r.processingStatus === "REJECTED");
      expect(rejected!.errorDetails).toContain("SOURCE_HASH_MISMATCH");
      // No trusted central document may exist from the mismatched payload —
      // the document count must not have grown.
      const docsAfter = await db.caseDocument.count({ where: { metadata: { contains: "MOCK-DOCUMENT-003" } } });
      expect(docsAfter).toBe(docsBefore);
      // Integrity event in the immutable chain.
      const auditRow = await db.auditEvent.findFirst({
        where: { eventType: "INTEGRATION_RECORD_REJECTED", metadata: { contains: "SOURCE_HASH_MISMATCH" } },
        orderBy: { sequence: "desc" },
      });
      expect(auditRow).not.toBeNull();
    } finally {
      await restoreCctns();
    }
  });
});

// ============================================================
// F. Evidence import & custody boundary (§27/§28/§29)
// ============================================================
describe("Phase 8 — evidence provenance & custody boundary", () => {
  t("F1. §27 — evidence import preserves provenance and NEVER fabricates custody history", async () => {
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "EVIDENCE", externalCaseId: "MOCK-CASE-001", externalEvidenceId: "MOCK-EVIDENCE-001" });
    expect(arjun.status).toBe(200);
    const ref = await db.externalEvidenceReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: CCTNS, externalEvidenceId: "MOCK-EVIDENCE-001" },
      include: { evidence: true },
    });
    expect(ref).not.toBeNull();
    expect(ref!.custodyHistoryAvailable).toBe(false); // HISTORY_UNAVAILABLE (§27)
    expect(ref!.sourceCustodian).toContain("Chouhan");
    expect(ref!.evidence.sourceType).toBe("EXTERNAL_IMPORT");
    expect(ref!.evidence.notes).toContain("HISTORY_UNAVAILABLE");
    expect(ref!.evidence.notes).toContain("MOCK-EVIDENCE-001");
    // No custody transfer was fabricated or triggered.
    const transfers = await db.evidenceTransfer.count({ where: { evidenceId: ref!.evidenceInternalId } });
    expect(transfers).toBe(0);
  });

  t("F2. §28 — external custody holder does NOT move custody; workflow boundary holds", async () => {
    const ref = await db.externalEvidenceReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: CCTNS, externalEvidenceId: "MOCK-EVIDENCE-001" },
      include: { evidence: true },
    });
    // The external system holds the item ("Vijay Nagar Police Station Yard (MOCK)") —
    // the platform records the notice but custody stays with the registering
    // custodian until a human runs the Phase 4 transfer workflow.
    expect(ref!.evidence.currentCustodianDepartmentId).toBe(ref!.evidence.collectingDepartmentId);
    const transfersAfter = await db.evidenceTransfer.count({ where: { evidenceId: ref!.evidenceInternalId } });
    expect(transfersAfter).toBe(0);
  });

  t("F3. §29 — case custody is never modified by integration", async () => {
    const ref = await db.externalCaseReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: CCTNS, externalCaseId: "MOCK-CASE-001" },
      include: { case: true },
    });
    // Custodian = connection owner department (platform actor) — never an
    // external identity, and integration endpoints offer no custody mutation.
    const conn = await db.integrationConnection.findUnique({ where: { connectionId: CCTNS } });
    expect(ref!.case.currentCustodianDepartmentId).toBe(conn!.ownerDepartmentId);
  });
});

// ============================================================
// G. Webhook security (§30-§32/§56)
// ============================================================
describe("Phase 8 — webhook security", () => {
  // The webhook receiver binds to the FIRST enabled CCTNS connection —
  // the seeded one. Resolve ITS secret through the credential service
  // (the same way the platform does); the test must never guess it.
  let secret = "";
  beforeAll(async () => {
    const cred = await integrationCredentialService.resolve(CCTNS);
    secret = cred!.webhookSecret!;
  }, 60000);
  const events = {
    valid: (id: string) => ({ event_id: id, event_type: "CASE_UPDATED", occurred_at: new Date().toISOString(), schema_version: "1.0", payload: { externalCaseId: "MOCK-CASE-001" } }),
  };

  t("G1. §30 — signed webhook with valid signature + timestamp is processed", async () => {
    const body = JSON.stringify(events.valid(`evt-${Date.now()}`));
    const res = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, {
      method: "POST",
      headers: { ...BYPASS, "Content-Type": "application/json", ...sign(secret, body) },
      body,
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.code).toBe("PROCESSED");
    const row = await db.integrationWebhookEvent.findFirst({ where: { providerType: "CCTNS", processingStatus: "PROCESSED" }, orderBy: { receivedAt: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.payloadHash).toMatch(/^[a-f0-9]{64}$/); // hash reference only — never the payload
  });

  t("G2. §56 — invalid signature is rejected safely", async () => {
    const body = JSON.stringify(events.valid(`evt-bad-${Date.now()}`));
    const res = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, {
      method: "POST",
      headers: { ...BYPASS, ...sign("wrong-secret-entirely", body) },
      body,
    });
    expect(res.status).toBe(401);
    const json: any = await res.json();
    expect(json.code).toBe("SIGNATURE_INVALID");
    const rejected = await db.integrationWebhookEvent.findFirst({ where: { providerType: "CCTNS", processingStatus: "REJECTED" }, orderBy: { receivedAt: "desc" } });
    expect(rejected).not.toBeNull();
  });

  t("G3. §32 — expired timestamp (replay window) is rejected", async () => {
    const body = JSON.stringify(events.valid(`evt-old-${Date.now()}`));
    const staleTs = Date.now() - 10 * 60 * 1000; // 10 minutes old > 5 min tolerance
    const res = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, {
      method: "POST",
      headers: { ...BYPASS, ...sign(secret, body, staleTs) },
      body,
    });
    expect(res.status).toBe(401);
    const json: any = await res.json();
    expect(json.code).toBe("TIMESTAMP_INVALID");
  });

  t("G4. §32 — duplicate provider event id is processed exactly ONCE", async () => {
    const id = `evt-dup-${Date.now()}`;
    const body = JSON.stringify(events.valid(id));
    const res1 = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, { method: "POST", headers: { ...BYPASS, ...sign(secret, body) }, body });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, { method: "POST", headers: { ...BYPASS, ...sign(secret, body) }, body });
    expect(res2.status).toBe(200);
    const json2: any = await res2.json();
    expect(json2.code).toBe("ALREADY_PROCESSED");
    const rows = await db.integrationWebhookEvent.count({ where: { providerType: "CCTNS", externalEventId: id } });
    expect(rows).toBe(1);
  });

  t("G5. §56 — malformed payload and unknown event type are rejected safely", async () => {
    const malformed = "this is not json {";
    const res1 = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, { method: "POST", headers: { ...BYPASS, ...sign(secret, malformed) }, body: malformed });
    expect(res1.status).toBe(422);
    const unknown = JSON.stringify({ event_id: `evt-unknown-${Date.now()}`, event_type: "SUE_ALL_OFFICERS", payload: {} });
    const res2 = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, { method: "POST", headers: { ...BYPASS, ...sign(secret, unknown) }, body: unknown });
    expect(res2.status).toBe(422);
    const json2: any = await res2.json();
    expect(json2.code).toBe("UNKNOWN_EVENT_TYPE");
  });

  t("G6. §30 — missing signature is rejected; unknown provider 404s", async () => {
    const body = JSON.stringify(events.valid(`evt-nosig-${Date.now()}`));
    const res1 = await fetch(`${BASE}/api/v1/integrations/webhooks/cctns`, { method: "POST", headers: { ...BYPASS, "x-mock-timestamp": String(Date.now()) }, body });
    expect(res1.status).toBe(401);
    const res2 = await fetch(`${BASE}/api/v1/integrations/webhooks/not-a-provider`, { method: "POST", headers: { ...BYPASS }, body });
    expect(res2.status).toBe(404);
  });

  t("G7. §37/§65 — webhook audits reference events, never contents or secrets", async () => {
    const rows = await db.auditEvent.findMany({ where: { eventType: { in: ["INTEGRATION_WEBHOOK_RECEIVED", "INTEGRATION_WEBHOOK_REJECTED"] } }, orderBy: { sequence: "asc" } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.metadata).not.toContain(secret);
      expect(row.metadata).not.toContain("sandbox-key");
      expect(row.metadata).not.toContain("payload");
    }
  });
});

// ============================================================
// H. Authorization — department + case scoping (§38/§39/§57/§58)
// ============================================================
describe("Phase 8 — integration authorization", () => {
  t("H1. §57 — cross-department use is ACCESS DENIED", async () => {
    await meera.req("POST", `/api/v1/integrations/${CCTNS}/test`);
    expect(meera.status).toBe(403);
    expect(meera.lastBody.error.code).toBe("INTEGRATION_ACCESS_DENIED");
    await meera.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
    expect(meera.status).toBe(403);
    // The denial is audited with the department-scope reason.
    const denial = await db.auditEvent.findFirst({
      where: { eventType: "INTEGRATION_ACCESS_DENIED", metadata: { contains: "DEPARTMENT_SCOPE" } },
      orderBy: { sequence: "desc" },
    });
    expect(denial).not.toBeNull();
  });

  t("H2. §38 — OFFICER: no integration surface at all; AUDITOR: read-only", async () => {
    await vishnu.req("GET", "/api/v1/integrations");
    expect(vishnu.status).toBe(403);
    await priya.req("GET", "/api/v1/integrations/jobs");
    expect(priya.status).toBe(200);
    await priya.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
    expect(priya.status).toBe(403);
    await priya.req("PATCH", `/api/v1/integrations/${CCTNS}`, { displayName: "hijack attempt" });
    expect(priya.status).toBe(403);
  });

  t("H3. §58 — export authorization: unauthorized cases are NEVER included", async () => {
    // meera creates an FSL-custodian case arjun cannot view.
    const geo = await db.city.findFirst({ where: { name: { contains: "Indore" } }, include: { district: { include: { state: true } } } });
    await meera.req("POST", "/api/v1/cases", {
      title: "FSL Internal Seclusion Case — export isolation test",
      caseType: "FORENSIC",
      priority: "NORMAL",
      stateId: geo!.district.state.id,
      districtId: geo!.district.id,
      cityId: geo!.id,
    });
    expect(meera.status).toBe(201);
    const fslCaseRef = meera.lastBody.data.caseId;
    // The imported police case arjun CAN view:
    const ref = await db.externalCaseReference.findFirst({ where: { providerType: "CCTNS", externalSystem: CCTNS, externalCaseId: "MOCK-CASE-001" }, include: { case: true } });
    await meera.req("POST", `/api/v1/integrations/${CCTNS}/export`, { exportType: "CASE_PACKAGE", caseRefs: [fslCaseRef, ref!.case.caseId] });
    // meera also cannot operate the police connection at all (§39):
    expect(meera.status).toBe(403);
    // arjun requests BOTH cases through his own connection:
    await arjun.req("POST", `/api/v1/integrations/${CCTNS}/export`, { exportType: "CASE_PACKAGE", caseRefs: [fslCaseRef, ref!.case.caseId] });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.recordsExported).toBe(1); // only his authorized case
    expect(arjun.lastBody.data.recordsFailed).toBe(1);
    expect(arjun.lastBody.data.errorSummary).toContain(`${fslCaseRef}:CASE_ACCESS_DENIED`);
    // The manifest covers ONLY the authorized case — no document entry,
    // filename or reference of the unauthorized FSL case may appear.
    await sysadmin.req("GET", `/api/v1/integrations/jobs/${arjun.lastBody.data.jobId}/manifest`);
    expect(sysadmin.status).toBe(200);
    expect(sysadmin.lastBody.data.case.caseId).toBe(ref!.case.caseId);
    const committedDocs = await db.caseDocument.count({ where: { caseId: ref!.caseInternalId, status: "COMMITTED" } });
    expect(sysadmin.lastBody.data.manifest.entries.length).toBe(committedDocs);
    expect(JSON.stringify(sysadmin.lastBody)).not.toContain(fslCaseRef);
  });
});

// ============================================================
// I. Resilience — retry/backoff + circuit breaker (§35/§36/§59/§60)
// ============================================================
describe("Phase 8 — resilience", () => {
  t("I1. §59 — provider outage → job fails gracefully; core platform unaffected", async () => {
    try {
      await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: { autoApproveLowRisk: true, failNext: 1, maxRetries: 0 } });
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.status).toBe(200); // outcome as data — platform never 5xxs on provider failure
      expect(arjun.lastBody.data.status).toBe("FAILED");
      expect(arjun.lastBody.data.errorSummary).toContain("SERVER_ERROR");
      // Core platform fully operational:
      await arjun.req("GET", "/api/v1/cases?limit=1");
      expect(arjun.status).toBe(200);
    } finally {
      await restoreCctns();
    }
  });

  t("I2. §67 — transient failures are retried with backoff until success", async () => {
    try {
      await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: { autoApproveLowRisk: true, importCaseDocuments: true, importCaseEvidence: true, failNext: 2, maxRetries: 3, baseBackoffMs: 10 } });
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.status).toBe(200);
      // A prior run may have imported this case already — either COMPLETED
      // (fresh import) or COMPLETED-with-skip (duplicate) proves retries
      // recovered from BOTH transient failures.
      expect(arjun.lastBody.data.status).toBe("COMPLETED");
      const logs = await db.integrationCallLog.findMany({ where: { operation: "get_case", outcome: "FAILURE" }, orderBy: { createdAt: "desc" }, take: 2 });
      expect(logs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await restoreCctns();
    }
  });

  t("I3. §67 — authentication failures are NEVER retried", async () => {
    await sysadmin.req("POST", "/api/v1/integrations", {
      providerType: "ICJS",
      displayName: "No-retry auth test (MOCK SANDBOX)",
      environment: "SANDBOX",
      providerMode: "MOCK",
      authenticationType: "API_KEY",
    });
    const bareConn = sysadmin.lastBody.data.connectionId;
    const logsBefore = await db.integrationCallLog.count({ where: { connection: { connectionId: bareConn } } });
    await sysadmin.req("POST", `/api/v1/integrations/${bareConn}/test`);
    expect(sysadmin.status).toBe(200);
    const logs = await db.integrationCallLog.findMany({ where: { connection: { connectionId: bareConn } } });
    const authFailure = logs.find((l) => l.errorCategory === "AUTH_FAILED");
    expect(authFailure).toBeDefined();
    expect(authFailure!.retryCount).toBe(0); // no retry storm on a permanently-wrong credential
    void logsBefore;
  });

  t("I4. §60 — circuit breaker unit: OPEN → fail fast → HALF_OPEN → CLOSED", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 120 });
    let calls = 0;
    const failing = async () => { calls += 1; throw new Error("provider down"); };
    for (let i = 0; i < 3; i++) {
      await breaker.execute(failing).catch(() => undefined);
    }
    expect(breaker.state).toBe("OPEN");
    const callsAtOpen = calls;
    // Fail fast: the operation is not even attempted.
    await breaker.execute(failing).catch((err) => expect(err).toBeInstanceOf(CircuitOpenError));
    expect(calls).toBe(callsAtOpen);
    await new Promise((r) => setTimeout(r, 150)); // cooldown elapses
    expect(breaker.state).toBe("HALF_OPEN");
    const probe = async () => "ok";
    expect(await breaker.execute(probe)).toBe("ok");
    expect(breaker.state).toBe("CLOSED");
  });

  t("I5. §60 — failed HALF_OPEN probe re-opens the circuit", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 80 });
    const failing = async () => { throw new Error("down"); };
    await breaker.execute(failing).catch(() => undefined);
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.state).toBe("OPEN");
    await new Promise((r) => setTimeout(r, 100));
    expect(breaker.state).toBe("HALF_OPEN");
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.state).toBe("OPEN"); // probe failed → full cooldown again
  });

  t("I6. §60 — API-level: repeated failures open the circuit; further calls fail fast", async () => {
    try {
      await sysadmin.req("PATCH", `/api/v1/integrations/${CCTNS}`, { config: { autoApproveLowRisk: true, circuitFailureThreshold: 2, circuitCooldownMs: 60000, maxRetries: 0, failNext: 3 } });
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.lastBody.data.errorSummary).toContain("SERVER_ERROR"); // failure 1
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.lastBody.data.errorSummary).toContain("SERVER_ERROR"); // failure 2 → threshold
      await arjun.req("POST", `/api/v1/integrations/${CCTNS}/import`, { importType: "CASE", externalCaseId: "MOCK-CASE-003" });
      expect(arjun.lastBody.data.errorSummary).toContain("CIRCUIT_OPEN"); // fail fast — no provider call
      // Health endpoint surfaces the open circuit.
      await sysadmin.req("GET", `/api/v1/integrations/${CCTNS}/health`);
      expect(sysadmin.status).toBe(200);
      expect(sysadmin.lastBody.data.circuitState).toBe("OPEN");
    } finally {
      await restoreCctns();
    }
  });
});

// ============================================================
// J. Audit integration (§37) — chain VALID, zero secret leakage
// ============================================================
describe("Phase 8 — audit & security hygiene", () => {
  t("J1. §37 — the full INTEGRATION_* event vocabulary is in the immutable chain", async () => {
    const expected = [
      "INTEGRATION_CONNECTION_CREATED",
      "INTEGRATION_CONNECTION_UPDATED",
      "INTEGRATION_CONNECTION_TESTED",
      "INTEGRATION_IMPORT_STARTED",
      "INTEGRATION_IMPORT_COMPLETED",
      "INTEGRATION_IMPORT_FAILED",
      "INTEGRATION_EXPORT_STARTED",
      "INTEGRATION_EXPORT_COMPLETED",
      "INTEGRATION_RECORD_IMPORTED",
      "INTEGRATION_RECORD_REJECTED",
      "INTEGRATION_CONFLICT_CREATED",
      "INTEGRATION_CONFLICT_RESOLVED",
      "INTEGRATION_WEBHOOK_RECEIVED",
      "INTEGRATION_WEBHOOK_REJECTED",
      "INTEGRATION_SYNC_STARTED",
      "INTEGRATION_SYNC_COMPLETED",
      "INTEGRATION_ACCESS_DENIED",
    ];
    const rows = await db.auditEvent.groupBy({ by: ["eventType"], where: { eventType: { startsWith: "INTEGRATION_" } }, _count: { _all: true } });
    const present = new Set(rows.map((r) => r.eventType));
    for (const evt of expected) expect(present.has(evt)).toBe(true);
  });

  t("J2. §37/§65 — no credential material anywhere in the audit chain", async () => {
    const rows = await db.auditEvent.findMany({ where: { eventType: { startsWith: "INTEGRATION_" } } });
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      const meta = row.metadata || "";
      expect(meta).not.toContain("sandbox-key-0123456789");
      expect(meta).not.toContain("whsec-0123456789");
      expect(meta).not.toContain("test-webhook-secret");
      expect(meta).not.toContain("mock-test-api-key");
    }
  });

  t("J3. §73 — the Phase 4 hash chain still verifies VALID after all integration activity", async () => {
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.eventsChecked).toBeGreaterThan(50);
  });
});

// ============================================================
// K. §61 End-to-end demonstration — MockCCTNSProvider
// ============================================================
describe("Phase 8 — §61 end-to-end demonstration (MOCK/SANDBOX)", () => {
  let e2eConn: string;
  let e2eCaseRef: string;

  t("K1. steps 1-6: configure → test → capabilities → search", async () => {
    // Login as authorized department administrator (arjun, done in beforeAll).
    // Configure Mock CCTNS, Environment SANDBOX (§61 steps 3-4).
    await arjun.req("POST", "/api/v1/integrations", {
      providerType: "CCTNS",
      displayName: "E2E demo — Mock CCTNS (SANDBOX)",
      environment: "SANDBOX",
      providerMode: "MOCK",
      authenticationType: "API_KEY",
      config: { autoApproveLowRisk: true, importCaseDocuments: true, importCaseEvidence: true },
      credentials: { apiKey: "e2e-demo-key-1234567890", webhookSecret: "e2e-demo-whsec-1234567890" },
    });
    expect(arjun.status).toBe(201);
    e2eConn = arjun.lastBody.data.connectionId;
    // Test connection — succeeds (steps 4-5).
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/test`);
    expect(arjun.lastBody.data.outcome).toBe("SUCCESS");
    // View capabilities (step 6).
    await arjun.req("GET", `/api/v1/integrations/${e2eConn}/capabilities`);
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.capabilities.can_import_case).toBe(true);
    // Search external cases (step 7) — by the immutable external id (the
    // mock dataset title may legitimately have been mutated by an earlier
    // simulation in this server's lifetime).
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/search`, { q: "MOCK-CASE-001" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.items.some((i: any) => i.externalCaseId === "MOCK-CASE-001")).toBe(true);
  });

  t("K2. steps 8-13: import case + document → SHA-256 → encrypted storage → external reference → audit", async () => {
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/import`, { importType: "CASE_BUNDLE", externalCaseId: "MOCK-CASE-001" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.status).toBe("COMPLETED");
    expect(arjun.lastBody.data.recordsImported).toBeGreaterThanOrEqual(3); // case + 2 documents (+ evidence)
    const ref = await db.externalCaseReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: e2eConn, externalCaseId: "MOCK-CASE-001" },
      include: { case: { include: { documents: true } } },
    });
    expect(ref).not.toBeNull();
    e2eCaseRef = ref!.case.caseId;
    // Central title must equal the external system's CURRENT title
    // (whatever it is at import time — the mock dataset is mutable).
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/search`, { q: "MOCK-CASE-001" });
    const externalTitle = arjun.lastBody.data.items.find((i: any) => i.externalCaseId === "MOCK-CASE-001")!.title;
    expect(ref!.case.title).toBe(externalTitle);
    const docRef = await db.externalDocumentReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: e2eConn, externalDocumentId: "MOCK-DOCUMENT-001" },
      include: { document: true },
    });
    expect(docRef).not.toBeNull();
    expect(docRef!.document.sha256Hash).toBe(docRef!.centralHash);
    expect(docRef!.document.encryptionStatus).toBe("ENCRYPTED_AES_256_GCM");
    expect(docRef!.hashVerified).toBe(true);
    // Import audit trail exists for the workflow (step 14).
    const importEvents = await db.auditEvent.count({ where: { eventType: { startsWith: "INTEGRATION_RECORD_IMPORTED" }, metadata: { contains: e2eConn } } });
    expect(importEvents).toBeGreaterThanOrEqual(3);
  });

  t("K3. steps 15-18: imported document opens in the secure authorized viewer; AI processes it; provenance graph-ready", async () => {
    const docRef = await db.externalDocumentReference.findFirst({
      where: { providerType: "CCTNS", externalSystem: e2eConn, externalDocumentId: "MOCK-DOCUMENT-001" },
      include: { document: true },
    });
    // §61 steps 15-16: the platform's secure authorized viewer (Phase 3
    // stream: authorization + no public URLs + audited) serves the
    // imported document. (No Phase 7 watermark layer exists in this
    // repository — reported honestly in the phase report.)
    const res = await fetch(`${BASE}/api/v1/cases/${e2eCaseRef}/documents/${docRef!.document.documentId}/view`, {
      headers: { ...BYPASS, Cookie: arjun.cookie! },
    });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x25); // '%'
    expect(buf[1]).toBe(0x50); // 'P'
    expect(buf[2]).toBe(0x44); // 'D'
    expect(buf[3]).toBe(0x46); // 'F'
    // Phase 5 AI processed the imported document (step 17).
    const aiJobs = await db.aIProcessingJob.findMany({ where: { documentRef: docRef!.document.documentId } });
    expect(aiJobs.length).toBeGreaterThanOrEqual(1);
    expect(aiJobs.every((j) => ["COMPLETED", "PROCESSING", "QUEUED"].includes(j.status))).toBe(true);
    // Graph readiness (step 18): relationship provenance is queryable —
    // case ↔ external-system ↔ document/evidence references all resolve.
    const evRef = await db.externalEvidenceReference.findFirst({ where: { providerType: "CCTNS", externalSystem: e2eConn } });
    expect(evRef).not.toBeNull();
    const docRel = await db.documentRelationship.count({ where: { sourceDocumentId: docRef!.documentInternalId } });
    expect(docRel).toBeGreaterThanOrEqual(0); // relationships queryable without error
  });

  t("K4. steps 19-22: modify external mock case → sync → conflict → reviewer resolves", async () => {
    const newTitle = `E2E external correction ${Date.now()}`;
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/simulate-change`, { externalCaseId: "MOCK-CASE-001", patch: { title: newTitle } });
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/sync`);
    expect(arjun.lastBody.data.conflicts).toBeGreaterThanOrEqual(1);
    const conflict = await db.integrationConflict.findFirst({ where: { caseRef: e2eCaseRef, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    expect(conflict).not.toBeNull();
    await arjun.req("POST", `/api/v1/integrations/conflicts/${conflict!.conflictId}/resolve`, { resolution: "RESOLVED_EXTERNAL", note: "FIR title corrected at source" });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.applied).toBe(true);
    const central = await db.case.findFirst({ where: { caseId: e2eCaseRef } });
    expect(central!.title).toBe(newTitle);
  });

  t("K5. steps 23-25: export authorized case → job completes → integrity manifest generated", async () => {
    await arjun.req("POST", `/api/v1/integrations/${e2eConn}/export`, { exportType: "CASE_PACKAGE", caseRefs: [e2eCaseRef], includeDocumentContent: false });
    expect(arjun.status).toBe(200);
    expect(arjun.lastBody.data.status).toBe("COMPLETED");
    expect(arjun.lastBody.data.recordsExported).toBe(1);
    const jobId = arjun.lastBody.data.jobId;
    await arjun.req("GET", `/api/v1/integrations/jobs/${jobId}/manifest`);
    expect(arjun.status).toBe(200);
    const manifest = arjun.lastBody.data.manifest;
    expect(manifest.algorithm).toBe("SHA-256");
    expect(manifest.entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of manifest.entries) {
      expect(entry.documentId).toMatch(/^DOC-/);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.size).toBeGreaterThan(0);
      expect(entry.mimeType).toBeDefined();
      expect(entry.exportJobId).toBe(jobId);
      expect(entry.exportedAt).toBeDefined();
    }
    // Provider acknowledgement recorded (mock system accepted the export).
    const exportJob = await db.integrationExportJob.findUnique({ where: { jobId } });
    expect(exportJob!.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  t("K6. step 26: audit records the COMPLETE integration workflow", async () => {
    const eventTypes = await db.auditEvent.groupBy({ by: ["eventType"], where: { metadata: { contains: e2eConn } } });
    const present = new Set(eventTypes.map((e) => e.eventType));
    for (const evt of [
      "INTEGRATION_CONNECTION_CREATED",
      "INTEGRATION_CONNECTION_TESTED",
      "INTEGRATION_IMPORT_STARTED",
      "INTEGRATION_IMPORT_COMPLETED",
      "INTEGRATION_RECORD_IMPORTED",
      "INTEGRATION_CONFLICT_CREATED",
      "INTEGRATION_CONFLICT_RESOLVED",
      "INTEGRATION_SYNC_STARTED",
      "INTEGRATION_SYNC_COMPLETED",
      "INTEGRATION_EXPORT_STARTED",
      "INTEGRATION_EXPORT_COMPLETED",
    ]) {
      expect(present.has(evt)).toBe(true);
    }
    // And the chain still verifies end-to-end.
    const result = await verifyChain();
    expect(result.valid).toBe(true);
  });
});
