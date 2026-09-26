/**
 * Phase 4 API & security test suite — Evidence Management + Immutable Audit.
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase4.test.ts
 *
 * Covers spec §56-§58/§73-§74: evidence registration (physical +
 * digital pipelines), validation, authorization matrix, custody
 * transfers and history, evidence-document relationships, append-only
 * audit (API + SQLite guard triggers), hash-chain verification, the
 * tamper acceptance test on a COPIED database (live data never
 * touched), concurrency of chained events, audit search, reports and
 * the ledger abstraction.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { copyFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifyChain } from "@/lib/audit/integrity";
import { AUDIT_GENESIS_HASH, canonicalAuditPayload } from "@/lib/audit/canonical";
import { getLedgerAdapter } from "@/lib/audit/ledger";
import { sanitizeClientMetadata } from "@/lib/audit/service";

const BASE = "http://localhost:3000";
// Bun's default per-test timeout (5s) is too tight for cold route compiles
// and burst loads — every network test gets 60s.
function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 60000);
}
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a", "connection": "close" }; // connection:close — kills the bun-fetch/Next-dev keep-alive race that intermittently delivers empty request bodies (500 JSON.parse)

// ---------- helpers ----------

function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const body = ["BT /F1 12 Tf", ...lines.map((l, i) => `1 0 0 1 60 ${760 - i * 20} Tm (${esc(l)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const MP4_SKELETON = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("mp42isom"),
  Buffer.from([0x00, 0x00, 0x00, 0x08]),
  Buffer.from("free"),
]);
const ZIP_MIN = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header
  Buffer.from([0x14, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00]),
  Buffer.from("test"),
  Buffer.from("demo"),
]);

class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;
  lastHeaders: Headers | null = null;

  get status() { return this.lastStatus; }

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = { ...BYPASS, ...(extraHeaders || {}) };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    this.lastStatus = res.status;
    this.lastHeaders = res.headers;
    const text = await res.text();
    try {
      this.lastBody = JSON.parse(text);
    } catch {
      this.lastBody = { raw: text };
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    return this;
  }
  get(path: string) { return this.req("GET", path); }
  post(path: string, body?: unknown) { return this.req("POST", path, body); }
  put(path: string, body?: unknown) { return this.req("PUT", path, body); }
  patch(path: string, body?: unknown) { return this.req("PATCH", path, body); }
  del(path: string) { return this.req("DELETE", path); }
  async login(email: string, password = SEED_PASSWORD) {
    return this.req("POST", "/api/v1/auth/login", { email, password });
  }
  code() { return this.lastBody?.error?.code; }
  msg() { return this.lastBody?.error?.message; }
  data() { return this.lastBody?.data; }
}

async function registerEvidence(
  client: Client,
  caseRef: string,
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Buffer } | null
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return client.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/evidence`, form);
}

const CASE2 = "CASE-MP-IND-2026-000002"; // FSL custodian; police ORIGINATING; prosecution PARTICIPATING
const CASE1 = "CASE-MP-IND-2026-000001"; // police custodian
const CLOSED_CASE = "CASE-MP-IND-2026-000004";

let sys: Client, adminPolice: Client, adminFsl: Client, adminProsecution: Client, officerPolice: Client, auditor: Client, unrelated: Client, anon: Client;
const stamp = Date.now();
let createdEvidenceIds: string[] = [];
let tmpDir: string | null = null;

beforeAll(async () => {
  sys = new Client(); await sys.login("sysadmin@demo.gov.in");
  adminPolice = new Client(); await adminPolice.login("arjun.sharma@demo.gov.in");
  adminFsl = new Client(); await adminFsl.login("meera.desai@demo.gov.in");
  adminProsecution = new Client(); await adminProsecution.login("rohan.verma@demo.gov.in");
  officerPolice = new Client(); await officerPolice.login("vishnu.kumar@demo.gov.in");
  auditor = new Client(); await auditor.login("priya.nair@demo.gov.in");
  unrelated = new Client(); await unrelated.login("devika.iyer@demo.gov.in");
  anon = new Client();
}, 60000);

afterAll(async () => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  await db.$disconnect();
}, 60000);

// ============================================================
// 1. Canonical serialization & genesis (spec §26/§27/§55)
// ============================================================
describe("canonical audit serialization", () => {
  t("genesis hash is the documented SHA-256 of the genesis seed", () => {
    expect(AUDIT_GENESIS_HASH).toBe(createHash("sha256").update("AUDIT_GENESIS|central-justice-platform|PHASE-4|v1").digest("hex"));
  });

  t("canonical payload is deterministic across metadata key order", () => {
    const base = {
      eventId: "EVT-2026-000001", sequence: 1, eventType: "EVIDENCE_CREATED",
      actorOfficerId: "OFF-1", actorDepartmentId: null, caseId: "CASE-1", documentId: null,
      evidenceId: "EVD-1", sessionId: null, timestamp: new Date("2026-09-24T10:00:00.000Z"),
      result: "SUCCESS", previousEventHash: AUDIT_GENESIS_HASH,
    };
    const a = canonicalAuditPayload({ ...base, metadata: JSON.stringify({ b: 2, a: 1, nested: { y: 2, x: 1 } }) });
    const b = canonicalAuditPayload({ ...base, metadata: JSON.stringify({ a: 1, nested: { x: 1, y: 2 }, b: 2 }) });
    expect(a).toBe(b);
    expect(a).toContain("previous_event_hash=" + AUDIT_GENESIS_HASH);
  });

  t("changing any hashed field changes the hash", () => {
    const base = {
      eventId: "EVT-2026-000001", sequence: 1, eventType: "EVIDENCE_CREATED",
      actorOfficerId: "OFF-1", actorDepartmentId: null, caseId: "CASE-1", documentId: null,
      evidenceId: "EVD-1", sessionId: null, timestamp: new Date("2026-09-24T10:00:00.000Z"),
      result: "SUCCESS", metadata: null, previousEventHash: AUDIT_GENESIS_HASH,
    };
    const h1 = createHash("sha256").update(canonicalAuditPayload(base)).digest("hex");
    const h2 = createHash("sha256").update(canonicalAuditPayload({ ...base, result: "DENIED" })).digest("hex");
    expect(h1).not.toBe(h2);
  });

  t("metadata sanitizer strips secret-shaped keys (spec §50)", () => {
    const clean = sanitizeClientMetadata({ password: "x", token: "y", authorization: "z", reason: "kept" });
    expect(clean).toEqual({ reason: "kept" });
  });
});

// ============================================================
// 2. Evidence registration — physical & digital (spec §5/§10/§11/§39)
// ============================================================
describe("evidence registration", () => {
  t("physical evidence registers with custody in one step (201)", async () => {
    const res = await registerEvidence(adminPolice, CASE1, {
      title: `Test Knife ${stamp}`,
      evidenceType: "PHYSICAL",
      classification: "CONFIDENTIAL",
      sourceType: "POLICE_SEIZURE",
      collectionLocation: "Test site A",
      collectedAt: "2026-09-20T10:00:00.000Z",
      condition: "Sealed",
    });
    expect(res.status).toBe(201);
    const ev = res.data().evidence;
    expect(ev.id).toMatch(/^EVD-MP-IND-2026-\d{6}$/);
    expect(ev.hasDigitalContent).toBe(false);
    expect(ev.sha256Hash).toBeNull();
    expect(ev.status).toBe("REGISTERED");
    expect(ev.currentCustodianDepartment?.departmentCode).toBe("DEPT-MP-IND-POL-001");
    createdEvidenceIds.push(ev.id);
  });

  t("digital evidence (PNG) registers with SHA-256 + encryption + commit (201)", async () => {
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `Test Photo ${stamp}`,
      evidenceType: "IMAGE",
      classification: "INTERNAL",
      sourceType: "FORENSIC_LAB",
    }, { name: "photo.png", type: "image/png", bytes: PNG_1PX });
    expect(res.status).toBe(201);
    const ev = res.data().evidence;
    expect(ev.hasDigitalContent).toBe(true);
    expect(ev.sha256Hash).toBe(createHash("sha256").update(PNG_1PX).digest("hex"));
    expect(ev.hashAlgorithm).toBe("SHA-256");
    expect(ev.encryptionStatus).toBe("ENCRYPTED_AES_256_GCM");
    expect(ev.mimeType).toBe("image/png");
    expect(ev.originalFilename).toBe("photo.png");
    createdEvidenceIds.push(ev.id);
  });

  t("evidence profile accepts mp4/zip and documents stay strict", async () => {
    const mp4 = await registerEvidence(adminFsl, CASE2, {
      title: `Test CCTV ${stamp}`, evidenceType: "VIDEO", classification: "RESTRICTED", sourceType: "CCTV_SYSTEM",
    }, { name: "CCTV.mp4", type: "video/mp4", bytes: MP4_SKELETON });
    expect(mp4.status).toBe(201);
    expect(mp4.data().evidence.mimeType).toBe("video/mp4");
    createdEvidenceIds.push(mp4.data().evidence.id);

    const zip = await registerEvidence(adminFsl, CASE2, {
      title: `Test Extraction ${stamp}`, evidenceType: "DIGITAL", classification: "RESTRICTED", sourceType: "DIGITAL_EXTRACTION",
    }, { name: "extraction.zip", type: "application/zip", bytes: ZIP_MIN });
    expect(zip.status).toBe(201);
    createdEvidenceIds.push(zip.data().evidence.id);

    // documents keep the Phase 3 whitelist: mp4 is NOT a document
    const docMp4 = await adminFsl.post(`/api/v1/cases/${CASE2}/documents`, (() => {
      const f = new FormData();
      f.append("file", new Blob([new Uint8Array(MP4_SKELETON)], { type: "video/mp4" }), "CCTV.mp4");
      f.append("title", "mp4 as document");
      f.append("documentType", "OTHER");
      f.append("classification", "INTERNAL");
      return f;
    })());
    expect(docMp4.status).toBe(415);
  });

  t("hash duplicate yields warning, never a block (spec §67 analog)", async () => {
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `Test Photo Again ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "FORENSIC_LAB",
    }, { name: "photo2.png", type: "image/png", bytes: PNG_1PX });
    expect(res.status).toBe(201);
    expect(res.data().duplicateWarning).toMatch(/^EVD-MP-IND-2026-/);
    createdEvidenceIds.push(res.data().evidence.id);
  });

  t("validation: bad type / bad source / bad classification / unknown officer (422/404)", async () => {
    let res = await registerEvidence(adminFsl, CASE2, {
      title: `Bad Type ${stamp}`, evidenceType: "NOT_A_TYPE", classification: "INTERNAL", sourceType: "OTHER",
    });
    expect([422, 400]).toContain(res.status);
    res = await registerEvidence(adminFsl, CASE2, {
      title: `Bad Source ${stamp}`, evidenceType: "DIGITAL", classification: "INTERNAL", sourceType: "TELEPORTATION",
    });
    expect([422, 400]).toContain(res.status);
    res = await registerEvidence(adminFsl, CASE2, {
      title: `Bad Class ${stamp}`, evidenceType: "DIGITAL", classification: "PUBLIC", sourceType: "OTHER",
    });
    expect([422, 400]).toContain(res.status);
    res = await registerEvidence(adminFsl, CASE2, {
      title: `Bad Officer ${stamp}`, evidenceType: "DIGITAL", classification: "INTERNAL", sourceType: "OTHER",
      collectedByOfficerId: "OFF-MP-IND-99999",
    });
    expect(res.status).toBe(404);
  });

  t("digital validation: exe rejected, magic mismatch rejected, empty rejected, oversized rejected", async () => {
    let res = await registerEvidence(adminFsl, CASE2, {
      title: `Exe ${stamp}`, evidenceType: "DIGITAL", classification: "INTERNAL", sourceType: "OTHER",
    }, { name: "evil.exe", type: "application/octet-stream", bytes: Buffer.from("MZ1234567890") });
    expect(res.status).toBe(415);

    res = await registerEvidence(adminFsl, CASE2, {
      title: `Mismatch ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "OTHER",
    }, { name: "fake.png", type: "image/png", bytes: Buffer.from("this is not a png") });
    expect(res.status).toBe(415);

    res = await registerEvidence(adminFsl, CASE2, {
      title: `Empty ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "OTHER",
    }, { name: "empty.png", type: "image/png", bytes: Buffer.alloc(0) });
    expect([422, 415]).toContain(res.status);

    const big = Buffer.alloc(26 * 1024 * 1024 + 1, 0x25); // "%PDF-" padded
    res = await registerEvidence(adminFsl, CASE2, {
      title: `Big ${stamp}`, evidenceType: "DIGITAL", classification: "INTERNAL", sourceType: "OTHER",
    }, { name: "big.pdf", type: "application/pdf", bytes: big });
    expect([413, 422]).toContain(res.status);
  });

  t("malicious content (EICAR) is rejected and leaves NO evidence row", async () => {
    const before = await db.evidence.count();
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `EICAR ${stamp}`, evidenceType: "DIGITAL", classification: "INTERNAL", sourceType: "OTHER",
    }, { name: "eicar.txt", type: "text/plain", bytes: Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*") });
    expect([422, 415]).toContain(res.status);
    const after = await db.evidence.count();
    expect(after).toBe(before);
  });

  t("mass assignment is rejected/ignored: client cannot mint identity, status, hash or storage (spec §13)", async () => {
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `Smuggle ${stamp}`,
      evidenceType: "DIGITAL",
      classification: "INTERNAL",
      sourceType: "OTHER",
      registeredByOfficerId: "OFF-MP-IND-00001",
      sha256Hash: "deadbeef",
      storageKey: "evidence/hacked/object",
      status: "ARCHIVED",
      currentCustodianDepartmentId: "hacked",
    } as unknown as Record<string, string>);
    // strict schema → validation error; even if accepted fields are ignored
    if (res.status === 201) {
      const ev = res.data().evidence;
      expect(ev.sha256Hash).not.toBe("deadbeef");
      expect(ev.status).not.toBe("ARCHIVED");
      createdEvidenceIds.push(ev.id);
    } else {
      expect([422, 400]).toContain(res.status);
    }
  });

  t("authorization: auditor, unrelated, anonymous and closed case all denied", async () => {
    const f = { name: "x.png", type: "image/png", bytes: PNG_1PX };
    let res = await registerEvidence(auditor, CASE2, { title: `A ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "OTHER" }, f);
    expect(res.status).toBe(403);
    res = await registerEvidence(unrelated, CASE1, { title: `B ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "OTHER" }, f);
    expect([403, 404]).toContain(res.status);
    res = await registerEvidence(anon, CASE2, { title: `C ${stamp}`, evidenceType: "IMAGE", classification: "INTERNAL", sourceType: "OTHER" }, f);
    expect(res.status).toBe(401);
    res = await registerEvidence(adminPolice, CLOSED_CASE, { title: `D ${stamp}`, evidenceType: "PHYSICAL", classification: "INTERNAL", sourceType: "OTHER" });
    expect(res.status).toBe(403);
  });

  t("HIGHLY_RESTRICTED ceiling: officers cannot assign it", async () => {
    const res = await registerEvidence(officerPolice, CASE1, {
      title: `Officer HR ${stamp}`, evidenceType: "PHYSICAL", classification: "HIGHLY_RESTRICTED", sourceType: "OTHER",
    });
    expect(res.status).toBe(403);
  });
});

// ============================================================
// 3. Access-control matrix (spec §19)
// ============================================================
describe("evidence access matrix", () => {
  t("seeded HIGHLY_RESTRICTED evidence is hidden from participating INTERNAL-level viewers in-query", async () => {
    // register a HIGHLY_RESTRICTED item by the custodian admin
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `HR Item ${stamp}`, evidenceType: "PHYSICAL", classification: "HIGHLY_RESTRICTED", sourceType: "OTHER",
    });
    expect(res.status).toBe(201);
    const hrId = res.data().evidence.id;
    createdEvidenceIds.push(hrId);

    // prosecution admin (participating, unassigned) clearance = INTERNAL → not in list
    const list = await adminProsecution.get(`/api/v1/cases/${CASE2}/evidence`);
    expect(list.status).toBe(200);
    expect(list.data().items.find((i: any) => i.id === hrId)).toBeUndefined();
    // …and a classification-targeted query cannot leak it either (spec §64 analog)
    const targeted = await adminProsecution.get(`/api/v1/cases/${CASE2}/evidence?classification=HIGHLY_RESTRICTED`);
    expect(targeted.data().items.length).toBe(0);
    // details denial is 403 + EVIDENCE_ACCESS_DENIED
    const denied = await adminProsecution.get(`/api/v1/cases/${CASE2}/evidence/${hrId}`);
    expect(denied.status).toBe(403);
    expect(denied.code()).toBe("EVIDENCE_ACCESS_DENIED");
    // the attempt is audited
    const audit = await sys.get(`/api/v1/audit?eventType=EVIDENCE_ACCESS_DENIED&evidenceId=${hrId}&pageSize=5`);
    expect(audit.data().items.length).toBeGreaterThanOrEqual(1);
  });

  t("custodian assigned officer can view; auditor read-only; anonymous 401; wrong-case evidence is 404", async () => {
    const evd1 = "EVD-MP-IND-2026-000001"; // seeded CCTV (RESTRICTED) — custodian now prosecution
    const byRohan = await adminProsecution.get(`/api/v1/cases/${CASE2}/evidence/${evd1}`);
    expect(byRohan.status).toBe(200);
    const byAuditor = await auditor.get(`/api/v1/cases/${CASE2}/evidence/${evd1}`);
    expect(byAuditor.status).toBe(200);
    const byAnon = await anon.get(`/api/v1/cases/${CASE2}/evidence/${evd1}`);
    expect(byAnon.status).toBe(401);
    // evidence exists but belongs to another case → 404, never 403 (no existence leak)
    const wrongCase = await adminPolice.get(`/api/v1/cases/${CASE1}/evidence/${evd1}`);
    expect(wrongCase.status).toBe(404);
    expect(wrongCase.code()).toBe("EVIDENCE_NOT_FOUND");
  });

  t("details never expose storageKey or keyReference (spec §5)", async () => {
    const res = await adminFsl.get(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000003`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.lastBody)).not.toContain("storageKey");
    expect(JSON.stringify(res.lastBody)).not.toContain("keyReference");
  });

  t("download returns byte-identical plaintext; unauthorized denied at case level", async () => {
    const res = await fetch(`${BASE}/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000003/download`, {
      headers: { ...BYPASS, Cookie: adminFsl.cookie! },
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(PNG_1PX).digest("hex"));
    const denied = await unrelated.get(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000003/download`);
    expect(denied.status).toBe(403);
  });
});

// ============================================================
// 4. Custody transfers (spec §16/§17/§44/§45)
// ============================================================
describe("evidence custody transfers", () => {
  const fsl = { code: "DEPT-MP-IND-FSL-001" };
  const prosecution = { code: "DEPT-MP-IND-PRO-001" };

  async function deptId(code: string) {
    return (await db.department.findUniqueOrThrow({ where: { departmentCode: code }, select: { id: true } })).id;
  }
  async function makeTransferItem(title: string) {
    const res = await registerEvidence(adminFsl, CASE2, {
      title, evidenceType: "PHYSICAL", classification: "INTERNAL", sourceType: "POLICE_SEIZURE",
    });
    expect(res.status).toBe(201);
    const id = res.data().evidence.id;
    createdEvidenceIds.push(id);
    return id;
  }

  t("rule 1: only the current custodian initiates (prosecution admin 403)", async () => {
    const id = await makeTransferItem(`Rule1 Item ${stamp}`);
    const res = await adminProsecution.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(fsl.code), reason: "Not the custodian",
    });
    expect([403, 422]).toContain(res.status);
  });

  t("rules 2/4/5: non-participant destination, unknown department, self-transfer rejected", async () => {
    const id = await makeTransferItem(`Rules245 Item ${stamp}`);
    let res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId("DEPT-MP-BHO-POL-001"), reason: "Not a case participant",
    });
    expect([422, 404]).toContain(res.status);
    res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: "nonexistent-dept", reason: "Unknown department",
    });
    expect(res.status).toBe(404);
    res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(fsl.code), reason: "Self transfer attempt",
    });
    expect(res.status).toBe(422);
  });

  t("rule 3: foreign receiving officer rejected", async () => {
    const id = await makeTransferItem(`Rule3 Item ${stamp}`);
    let res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), toOfficerId: "OFF-MP-IND-00001", reason: "Officer from another department",
    });
    expect(res.status).toBe(422);
    res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), toOfficerId: "OFF-MP-IND-99999", reason: "Unknown officer",
    });
    expect(res.status).toBe(404);
  });

  t("accept path: REQUESTED → custody flips to receiving department + TRANSFERRED + audited", async () => {
    const id = await makeTransferItem(`Accept Path Item ${stamp}`);
    const req = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), reason: "Trial preparation handover",
    });
    expect(req.status).toBe(201);
    const transferId = req.data().transfer.transferId;
    expect(transferId).toMatch(/^ETR-MP-IND-2026-\d{6}$/);

    const again = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), reason: "Should conflict",
    });
    expect(again.status).toBe(409);

    const wrongDecider = await adminPolice.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "ACCEPT" });
    expect(wrongDecider.status).toBe(403);

    const accept = await adminProsecution.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "ACCEPT" });
    expect(accept.status).toBe(200);

    const details = await adminFsl.get(`/api/v1/cases/${CASE2}/evidence/${id}`);
    expect(details.data().evidence.status).toBe("TRANSFERRED");
    expect(details.data().evidence.currentCustodianDepartment?.departmentCode).toBe("DEPT-MP-IND-PRO-001");

    const byReceiver = await adminProsecution.get(`/api/v1/cases/${CASE2}/evidence/${id}`);
    expect(byReceiver.status).toBe(200);

    const audit = await sys.get(`/api/v1/audit?evidenceId=${id}&pageSize=20`);
    const types = audit.data().items.map((i: any) => i.eventType);
    expect(types).toContain("EVIDENCE_TRANSFER_REQUESTED");
    expect(types).toContain("EVIDENCE_TRANSFER_ACCEPTED");

    const reAccept = await adminProsecution.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "ACCEPT" });
    expect(reAccept.status).toBe(409);
  });

  t("reject path: custody unchanged, previous status restored, rejection audited", async () => {
    const id = await makeTransferItem(`Reject Path Item ${stamp}`);
    await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/status`, { status: "IN_CUSTODY", reason: "locker" });
    const req = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), reason: "Second handover attempt",
    });
    expect(req.status).toBe(201);
    const transferId = req.data().transfer.transferId;
    const reject = await adminProsecution.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "REJECT" });
    expect(reject.status).toBe(200);
    const details = await adminFsl.get(`/api/v1/cases/${CASE2}/evidence/${id}`);
    expect(details.data().evidence.status).toBe("IN_CUSTODY");
    expect(details.data().evidence.currentCustodianDepartment?.departmentCode).toBe("DEPT-MP-IND-FSL-001");
    const audit = await sys.get(`/api/v1/audit?evidenceId=${id}&eventType=EVIDENCE_TRANSFER_REJECTED&pageSize=5`);
    expect(audit.data().items.length).toBeGreaterThanOrEqual(1);
  });

  t("cancel path: requesting side only; decision-side cancel denied", async () => {
    const id = await makeTransferItem(`Cancel Path Item ${stamp}`);
    const req = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers`, {
      toDepartmentId: await deptId(prosecution.code), reason: "Will cancel this one",
    });
    const transferId = req.data().transfer.transferId;
    const wrongCancel = await adminProsecution.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "CANCEL" });
    expect(wrongCancel.status).toBe(403);
    const cancel = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/transfers/${transferId}/decide`, { action: "CANCEL" });
    expect(cancel.status).toBe(200);
    const audit = await sys.get(`/api/v1/audit?evidenceId=${id}&eventType=EVIDENCE_TRANSFER_CANCELLED&pageSize=5`);
    expect(audit.data().items.length).toBeGreaterThanOrEqual(1);
  });

  t("custody chain history is chronological and includes COLLECTED + transfers (spec §18)", async () => {
    const chain = await adminFsl.get(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000001/transfers`);
    expect(chain.status).toBe(200);
    expect(chain.data().chain[0].kind).toBe("COLLECTED");
    expect(chain.data().chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.data().currentCustodian.department).toContain("Prosecution");
  });

  t("§45: case custody is untouched by evidence transfers", async () => {
    const access = await adminFsl.get(`/api/v1/cases/${CASE2}/access`);
    expect(access.data().isCustodianSide).toBe(true);
  });
});

// ============================================================
// 5. Evidence-document relationships (spec §20)
// ============================================================
describe("evidence-document relationships", () => {
  let linkableEvidence = "";

  beforeAll(async () => {
    const res = await registerEvidence(adminPolice, CASE1, {
      title: `Link Target ${stamp}`, evidenceType: "DEVICE", classification: "RESTRICTED", sourceType: "POLICE_SEIZURE",
    });
    linkableEvidence = res.data().evidence.id;
    createdEvidenceIds.push(linkableEvidence);
  }, 60000);

  t("DESCRIBES link created; duplicates 409; unknown type 422; missing doc 404", async () => {
    const link = await adminPolice.post(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`, {
      documentId: "DOC-MP-IND-2026-000001", relationshipType: "DESCRIBES", note: "FIR describes the scene",
    });
    expect(link.status).toBe(201);
    const dup = await adminPolice.post(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`, {
      documentId: "DOC-MP-IND-2026-000001", relationshipType: "DESCRIBES",
    });
    expect(dup.status).toBe(409);
    const badType = await adminPolice.post(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`, {
      documentId: "DOC-MP-IND-2026-000001", relationshipType: "CAUSES",
    });
    expect(badType.status).toBe(422);
    const missing = await adminPolice.post(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`, {
      documentId: "DOC-MP-IND-2026-999999", relationshipType: "SUPPORTS",
    });
    expect(missing.status).toBe(404);
    const list = await adminPolice.get(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`);
    expect(list.data().relationships.length).toBe(1);
    expect(list.data().relationships[0].relationshipType).toBe("DESCRIBES");
  });

  t("cross-case documents are 404 (existence never leaked)", async () => {
    // DOC-MP-IND-2026-000003 belongs to CASE1; link it against CASE2 evidence
    const res = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000003/relationships`, {
      documentId: "DOC-MP-IND-2026-000003", relationshipType: "RELATED",
    });
    expect(res.status).toBe(404);
  });

  t("auditor cannot create relationships (read-only, spec §34)", async () => {
    const res = await auditor.post(`/api/v1/cases/${CASE1}/evidence/${linkableEvidence}/relationships`, {
      documentId: "DOC-MP-IND-2026-000001", relationshipType: "RELATED",
    });
    expect(res.status).toBe(403);
  });

  t("relationship creation is audited", async () => {
    const audit = await sys.get(`/api/v1/audit?evidenceId=${linkableEvidence}&eventType=EVIDENCE_RELATIONSHIP_CREATED&pageSize=5`);
    expect(audit.data().items.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// 6. Evidence status transitions (spec §8)
// ============================================================
describe("evidence status service", () => {
  t("legal transition works and is audited; illegal transition 422; audit mirrors in case timeline", async () => {
    const res = await registerEvidence(adminFsl, CASE2, {
      title: `Status Item ${stamp}`, evidenceType: "PHYSICAL", classification: "INTERNAL", sourceType: "OTHER",
    });
    const id = res.data().evidence.id;
    createdEvidenceIds.push(id);

    const ok = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/status`, { status: "IN_CUSTODY", reason: "Locker A" });
    expect(ok.status).toBe(200);
    expect(ok.data().evidence.status).toBe("IN_CUSTODY");

    const illegal = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/status`, { status: "REGISTERED" });
    expect(illegal.status).toBe(422);

    const serviceManaged = await adminFsl.post(`/api/v1/cases/${CASE2}/evidence/${id}/status`, { status: "TRANSFER_PENDING" });
    expect(serviceManaged.status).toBe(422);

    const audit = await sys.get(`/api/v1/audit?evidenceId=${id}&eventType=EVIDENCE_STATUS_CHANGED&pageSize=5`);
    expect(audit.data().items.length).toBe(1);
  });

  t("auditor cannot change status (spec §34)", async () => {
    const res = await auditor.post(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000002/status`, { status: "ARCHIVED" });
    expect(res.status).toBe(403);
  });
});

// ============================================================
// 7. Append-only audit & hash chain (spec §24/§25/§28/§48/§54/§56)
// ============================================================
describe("audit hash chain", () => {
  t("every event links to its predecessor; first event links to documented genesis", async () => {
    const page1 = await auditor.get("/api/v1/audit?pageSize=100&page=1");
    const items: any[] = page1.data().items; // descending by sequence
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < items.length - 1; i++) {
      const newer = items[i];
      const older = items[i + 1];
      expect(newer.previousEventHash).toBe(older.eventHash);
      expect(newer.sequence).toBe(older.sequence + 1);
    }
    // The oldest event is on the LAST page (descending order) — fetch it there.
    const total = page1.data().total;
    const lastPage = Math.max(1, Math.ceil(total / 100));
    const oldestPage = await sys.get(`/api/v1/audit?page=${lastPage}&pageSize=100`);
    const first = oldestPage.data().items[oldestPage.data().items.length - 1];
    expect(first.sequence).toBe(1);
    expect(first.previousEventHash).toBe(AUDIT_GENESIS_HASH);
  });

  t("full-chain verification returns VALID (spec §73 step 19)", async () => {
    const res = await auditor.post("/api/v1/audit/integrity");
    expect(res.status).toBe(200);
    expect(res.data().valid).toBe(true);
    expect(res.data().firstInvalid).toBeNull();
    expect(res.data().eventsChecked).toBe(res.data().toSequence);
  });

  t("audit search is itself audited and supports filters (spec §33/§34)", async () => {
    const before = await sys.get("/api/v1/audit?eventType=AUDIT_SEARCHED&pageSize=1");
    const beforeCount = before.data().total;
    await auditor.get(`/api/v1/audit?caseId=${CASE2}&result=SUCCESS&pageSize=5`);
    const after = await sys.get("/api/v1/audit?eventType=AUDIT_SEARCHED&pageSize=1");
    expect(after.data().total).toBeGreaterThan(beforeCount);
  });

  t("audit access control: officers/admins denied, anonymous 401, detail 404", async () => {
    expect((await officerPolice.get("/api/v1/audit")).status).toBe(403);
    expect((await adminPolice.get("/api/v1/audit")).status).toBe(403);
    expect((await anon.get("/api/v1/audit")).status).toBe(401);
    expect((await auditor.get("/api/v1/audit/EVT-0000-999999")).status).toBe(404);
  });

  t("failed logins enter the chain without resolving actors (spec §22)", async () => {
    const bad = new Client();
    await bad.req("POST", "/api/v1/auth/login", { email: "ghost@demo.gov.in", password: "WrongPass1" });
    expect(bad.status).toBe(401);
    const audit = await auditor.get("/api/v1/audit?eventType=LOGIN_FAILED&pageSize=3");
    const ev = audit.data().items[0];
    expect(ev.actor).toBeNull();
    expect(ev.actorIdentifier).toBe("ghost@demo.gov.in");
    expect(ev.result).toBe("DENIED");
  });

  t("concurrent chained writes stay contiguous and valid (spec §54)", async () => {
    // 8 parallel authorized evidence detail views → 8 EVIDENCE_VIEWED chain writes
    const target = "EVD-MP-IND-2026-000003";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        adminFsl.get(`/api/v1/cases/${CASE2}/evidence/${target}`).then((r) => r.status).catch(() => 500)
      )
    );
    expect(results.every((s) => s === 200)).toBe(true);
    const res = await sys.post("/api/v1/audit/integrity");
    expect(res.data().valid).toBe(true);
    const state = await db.auditChainState.findUniqueOrThrow({ where: { id: "SINGLETON" } });
    // Gap-free 1..lastSequence with unique sequences: row count must equal the head.
    const [row] = await db.$queryRawUnsafe<{ n: number; m: number }[]>(
      `SELECT COUNT(*) AS n, MAX(sequence) AS m FROM AuditEvent`
    );
    expect(Number(row.m)).toBe(state.lastSequence);
    expect(Number(row.n)).toBe(state.lastSequence);
  });

  t("TAMPER ACCEPTANCE (spec §56/§73 step 20-22): modified history → INVALID at the right position", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-tamper-"));
    const copyPath = join(tmpDir, "tampered.db");
    copyFileSync("/home/z/my-project/db/custom.db", copyPath);

    // A privileged DBA bypasses application controls: drop the guards on the COPY.
    const tamperedDb = new PrismaClient({ datasources: { db: { url: `file:${copyPath}` } } });
    await tamperedDb.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_events_no_update`);

    // Build a 100-event synthetic chain on the copy, starting after the live head.
    const head = await tamperedDb.auditEvent.findFirst({ orderBy: { sequence: "desc" } });
    let previous = head!.eventHash;
    let seq = head!.sequence;
    const baseMs = Date.UTC(2026, 8, 24, 12, 0, 0);
    for (let i = 0; i < 100; i++) {
      seq += 1;
      const eventId = `EVT-SYNTH-${String(i).padStart(6, "0")}`;
      const eventHash = createHash("sha256").update(
        canonicalAuditPayload({
          eventId, sequence: seq, eventType: "EVIDENCE_VIEWED", actorOfficerId: null, actorDepartmentId: null,
          caseId: "CASE-SYNTH", documentId: null, evidenceId: null, sessionId: null,
          timestamp: new Date(baseMs + i * 1000), result: "SUCCESS", metadata: null, previousEventHash: previous,
        })
      ).digest("hex");
      await tamperedDb.$executeRawUnsafe(
        `INSERT INTO AuditEvent (id, sequence, eventId, eventType, caseId, timestamp, result, previousEventHash, eventHash, ledgerStatus, createdAt)
         VALUES ('${randomUUID()}', ${seq}, '${eventId}', 'EVIDENCE_VIEWED', 'CASE-SYNTH', ${baseMs + i * 1000}, 'SUCCESS', '${previous}', '${eventHash}', 'UNANCHORED', ${baseMs})`
      );
      previous = eventHash;
    }

    // Baseline: the copy verifies VALID (spec §56 step 1).
    const cleanResult = await verifyChain(tamperedDb);
    expect(cleanResult.valid).toBe(true);

    // TAMPER: silently modify one historical event (spec §56 step 2).
    await tamperedDb.$executeRawUnsafe(`UPDATE AuditEvent SET metadata = '{"tampered":true}' WHERE eventId = 'EVT-SYNTH-000042'`);

    // Verification must detect the FIRST broken event with details (spec §56 step 3).
    const result = await verifyChain(tamperedDb);
    expect(result.valid).toBe(false);
    expect(result.firstInvalid).not.toBeNull();
    expect(result.firstInvalid!.eventId).toBe("EVT-SYNTH-000042");
    expect(result.firstInvalid!.sequence).toBe(head!.sequence + 43);
    expect(result.firstInvalid!.reason).toBe("HASH_MISMATCH");
    expect(result.firstInvalid!.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.firstInvalid!.actualHash).toMatch(/^[0-9a-f]{64}$/);

    await tamperedDb.$disconnect();
  });

  t("SQLite guards: direct UPDATE/DELETE of audit events, evidence integrity fields and decided transfers ABORT (spec §58)", async () => {
    const anyEvent = await db.auditEvent.findFirst({ orderBy: { sequence: "asc" } });
    let updateFailed = false, deleteFailed = false;
    try { await db.$executeRawUnsafe(`UPDATE AuditEvent SET result = 'FAILED' WHERE id = '${anyEvent!.id}'`); } catch { updateFailed = true; }
    try { await db.$executeRawUnsafe(`DELETE FROM AuditEvent WHERE id = '${anyEvent!.id}'`); } catch { deleteFailed = true; }
    expect(updateFailed).toBe(true);
    expect(deleteFailed).toBe(true);

    const digital = await db.evidence.findFirst({ where: { hasDigitalContent: true } });
    let hashUpdateFailed = false;
    try { await db.$executeRawUnsafe(`UPDATE Evidence SET sha256Hash = 'deadbeef' WHERE id = '${digital!.id}'`); } catch { hashUpdateFailed = true; }
    expect(hashUpdateFailed).toBe(true);

    let evidenceDeleteFailed = false;
    try { await db.$executeRawUnsafe(`DELETE FROM Evidence WHERE id = '${digital!.id}'`); } catch { evidenceDeleteFailed = true; }
    expect(evidenceDeleteFailed).toBe(true);

    const decided = await db.evidenceTransfer.findFirst({ where: { status: { not: "REQUESTED" } } });
    let historyUpdateFailed = false, historyDeleteFailed = false;
    try { await db.$executeRawUnsafe(`UPDATE EvidenceTransfer SET reason = 'rewritten' WHERE id = '${decided!.id}'`); } catch { historyUpdateFailed = true; }
    try { await db.$executeRawUnsafe(`DELETE FROM EvidenceTransfer WHERE id = '${decided!.id}'`); } catch { historyDeleteFailed = true; }
    expect(historyUpdateFailed).toBe(true);
    expect(historyDeleteFailed).toBe(true);

    // No API surface exists for audit mutation either
    expect((await sys.put(`/api/v1/audit/${anyEvent!.eventId}`, { result: "FAILED" })).status).toBe(405);
    expect((await sys.del(`/api/v1/audit/${anyEvent!.eventId}`)).status).toBe(405);
  });
});

// ============================================================
// 8. Ledger abstraction & anchoring (spec §30/§31/§67/§68)
// ============================================================
describe("ledger abstraction", () => {
  t("DATABASE adapter is live; Hyperledger Fabric is a labeled 501 stub — never claimed", async () => {
    const dbAdapter = getLedgerAdapter("DATABASE");
    expect(dbAdapter.live).toBe(true);
    const fabric = getLedgerAdapter("HYPERLEDGER_FABRIC");
    expect(fabric.live).toBe(false);
    await expect(fabric.anchor({ chainHash: "x", upToSequence: 1, eventCount: 1 })).rejects.toThrow(/NOT implemented|NOT IMPLEMENTED/i);
  });

  t("SYSTEM_ADMIN anchors the verified chain head; events become ANCHORED; anchor verifies", async () => {
    const before = await auditor.get("/api/v1/audit/integrity");
    const headBefore = before.data().chain.lastSequence;

    const anchor = await sys.post("/api/v1/ledger/anchors");
    expect(anchor.status).toBe(201);
    expect(anchor.data().anchorId).toMatch(/^ANCHOR-2026-\d{6}$/);
    expect(anchor.data().upToSequence).toBe(headBefore);
    expect(anchor.data().chainHash).toBe(before.data().chain.lastEventHash);

    const anchored = await db.auditEvent.count({ where: { ledgerStatus: "ANCHORED" } });
    expect(anchored).toBe(headBefore);

    const list = await auditor.get("/api/v1/ledger/anchors");
    expect(list.data().anchors.length).toBeGreaterThanOrEqual(1);

    const verify = await auditor.post(`/api/v1/ledger/anchors/${anchor.data().anchorId}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.data().valid).toBe(true);
  });

  t("only auditors/admins read anchors; non-admin anchoring is denied", async () => {
    expect((await adminPolice.get("/api/v1/ledger/anchors")).status).toBe(403);
    expect((await adminPolice.post("/api/v1/ledger/anchors")).status).toBe(403);
  });
});

// ============================================================
// 9. Reports (spec §41/§42/§43/§65/§66)
// ============================================================
describe("reports", () => {
  t("chain-of-custody report: collection + chronological custody + fingerprint + disclaimer + integrity hash", async () => {
    const res = await auditor.get(`/api/v1/reports/chain-of-custody?caseId=${CASE2}&evidenceId=EVD-MP-IND-2026-000001`);
    expect(res.status).toBe(200);
    const r = res.data().report;
    expect(r.reportId).toMatch(/^RPT-/);
    expect(r.disclaimer).toContain("does not certify court admissibility");
    expect(r.custodyChain.length).toBeGreaterThanOrEqual(2);
    expect(r.custodyChain[0].action).toBe("COLLECTED");
    expect(r.integrity.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.currentCustodian.department).toContain("Prosecution");
    expect(r.integrityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  t("integrity report lists documents + evidence without file contents", async () => {
    const res = await auditor.get(`/api/v1/reports/integrity?caseId=${CASE1}`);
    expect(res.status).toBe(200);
    const r = res.data().report;
    expect(r.documents.length).toBeGreaterThanOrEqual(4);
    expect(r.evidence.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r)).not.toContain("storageKey");
  });

  t("compliance report: auditor OK; includes audit history; officer denied", async () => {
    const res = await auditor.get(`/api/v1/reports/compliance?caseId=${CASE2}`);
    expect(res.status).toBe(200);
    expect(res.data().report.auditHistory.eventCount).toBeGreaterThan(0);
    expect((await adminPolice.get(`/api/v1/reports/compliance?caseId=${CASE2}`)).status).toBe(403);
  });

  t("report generation is audited; unauthorized generation denied", async () => {
    const audit = await auditor.get("/api/v1/audit?eventType=REPORT_GENERATED&pageSize=3");
    expect(audit.data().items.length).toBeGreaterThanOrEqual(1);
    const denied = await unrelated.get(`/api/v1/reports/integrity?caseId=${CASE1}`);
    expect(denied.status).toBe(403);
  });
});

// ============================================================
// 10. Case integrity summary (spec §62)
// ============================================================
describe("case integrity summary", () => {
  t("counts + live chain status; informational only", async () => {
    const res = await auditor.get(`/api/v1/cases/${CASE2}/integrity`);
    expect(res.status).toBe(200);
    expect(res.data().documents).toBeGreaterThanOrEqual(0);
    expect(res.data().evidence).toBeGreaterThanOrEqual(3);
    expect(res.data().chain.valid).toBe(true);
    expect(res.data().chain.informationalOnly).toBe(true);
  });

  t("audit-event counts are auditor/admin-only information", async () => {
    const forOfficer = await officerPolice.get(`/api/v1/cases/${CASE2}/integrity`);
    expect(forOfficer.data().auditEvents).toBeNull();
    expect(forOfficer.data().auditEventsNote).toBeDefined();
  });
});

// ============================================================
// 11. Immutability surface: no mutation endpoints for evidence (spec §58)
// ============================================================
describe("evidence immutability surface", () => {
  t("no PUT/PATCH/DELETE route exists for evidence or transfers", async () => {
    expect((await adminFsl.put(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000001`, { title: "x" })).status).toBe(405);
    expect((await adminFsl.patch(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000001`, { title: "x" })).status).toBe(405);
    expect((await adminFsl.del(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000001`)).status).toBe(405);
    expect((await adminFsl.del(`/api/v1/cases/${CASE2}/evidence/EVD-MP-IND-2026-000001/transfers/ETR-MP-IND-2026-000001`)).status).toBeGreaterThanOrEqual(400);
  });
});
