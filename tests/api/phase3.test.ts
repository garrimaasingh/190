/**
 * Phase 3 API & security test suite — Secure Digital Document Management.
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase3.test.ts
 *
 * Covers spec §74-§81: model, upload validation, immutability,
 * access-control matrix, custody rules, relationships, download
 * security, events, idempotency and search. Includes direct
 * service-level tests for the crypto/integrity/storage seams.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Bun's default per-test timeout (5s) is too tight for cold route
// compiles and AI-drain-coincident uploads — same convention as the
// phase4/phase5 suites: every network test gets 60s.
function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 60000);
}
import { PrismaClient } from "@prisma/client";
import { rmSync } from "fs";

const BASE = "http://localhost:3000";
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

// Minimal valid 1x1 PNG
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const CASE1 = "CASE-MP-IND-2026-000001";
const DOC1 = "DOC-MP-IND-2026-000001";

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
    return this; // chainable: res.data() / res.status work on the client itself
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

/** multipart upload convenience */
async function uploadDoc(client: Client, caseRef: string, file: { name: string; type: string; bytes: Buffer }, fields: Record<string, string>) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return client.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/documents`, form);
}

async function uploadRelated(client: Client, caseRef: string, docId: string, workflow: string, file: { name: string; type: string; bytes: Buffer }, fields: Record<string, string>) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return client.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(docId)}/${workflow}`, form);
}

const F = { name: "test.pdf", type: "application/pdf", bytes: makePdf(["Phase 3 test document"]) };

let sys: Client, adminPolice: Client, adminFsl: Client, officerPolice: Client, auditor: Client, adminBhopal: Client, anon: Client;
const stamp = Date.now();
let geo: { stateId: string; districtId: string; cityId: string };
const createdCaseInternalIds: string[] = [];
const createdDocInternalIds: string[] = [];
const createdDocPublicIds: string[] = [];

async function createTestCase(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client.post("/api/v1/cases", {
    title: `Phase 3 Test Case ${stamp}`,
    caseType: "CRIMINAL",
    priority: "NORMAL",
    ...geo,
    ...overrides,
  });
  if (res.status === 201 && client.data()?.id) createdCaseInternalIds.push(client.data().id);
  return res;
}

beforeAll(async () => {
  sys = new Client(); await sys.login("sysadmin@demo.gov.in");
  adminPolice = new Client(); await adminPolice.login("arjun.sharma@demo.gov.in");
  adminFsl = new Client(); await adminFsl.login("meera.desai@demo.gov.in");
  officerPolice = new Client(); await officerPolice.login("vishnu.kumar@demo.gov.in");
  auditor = new Client(); await auditor.login("priya.nair@demo.gov.in");
  adminBhopal = new Client(); await adminBhopal.login("devika.iyer@demo.gov.in");
  anon = new Client();

  await sys.get("/api/v1/geography/countries");
  const india = sys.data().find((x: any) => x.code === "IN");
  await sys.get(`/api/v1/geography/states?countryId=${india.id}`);
  const mp = sys.data().find((s: any) => s.code === "MP");
  await sys.get(`/api/v1/geography/states/${mp.id}/districts`);
  const indoreD = sys.data().find((d: any) => d.code === "IND");
  await sys.get(`/api/v1/geography/districts/${indoreD.id}/cities`);
  const indoreC = sys.data().find((x: any) => x.code === "IND");
  geo = { stateId: mp.id, districtId: indoreD.id, cityId: indoreC.id };
}, 60000);

afterAll(async () => {
  // Best-effort test cleanup (a full reset+reseed follows the suite anyway).
  for (const docInternalId of createdDocInternalIds) {
    try {
      const doc = await db.caseDocument.findUnique({ where: { id: docInternalId } });
      if (doc) {
        await db.documentRelationship.deleteMany({ where: { OR: [{ sourceDocumentId: doc.id }, { targetDocumentId: doc.id }] } });
        await db.documentEvent.deleteMany({ where: { documentId: doc.id } });
        await db.caseDocument.delete({ where: { id: doc.id } });
        const path = `${process.cwd()}/db/uploads/documents/${doc.storageKey}`;
        rmSync(path, { force: true });
      }
    } catch { /* best effort */ }
  }
  for (const caseInternalId of createdCaseInternalIds) {
    try {
      const docs = await db.caseDocument.findMany({ where: { caseId: caseInternalId } });
      for (const doc of docs) {
        await db.documentRelationship.deleteMany({ where: { OR: [{ sourceDocumentId: doc.id }, { targetDocumentId: doc.id }] } });
        await db.documentEvent.deleteMany({ where: { documentId: doc.id } });
        await db.caseDocument.delete({ where: { id: doc.id } });
        rmSync(`${process.cwd()}/db/uploads/documents/${doc.storageKey}`, { force: true });
      }
      await db.documentUploadSession.deleteMany({ where: { caseId: caseInternalId } });
      await db.documentEvent.deleteMany({ where: { caseId: caseInternalId } });
      await db.caseEvent.deleteMany({ where: { caseId: caseInternalId, eventType: { startsWith: "DOCUMENT" } } });
    } catch { /* best effort */ }
  }
  await db.$disconnect();
}, 60000);

// ============================================================
// A. Service-level seams (crypto, integrity, validation, scanner,
//    storage path safety) — direct imports, no HTTP.
// ============================================================
describe("Phase 3 — service seams", () => {
  t("AES-256-GCM encryption round-trips plaintext", async () => {
    const { encryptDocument, decryptDocument } = await import("@/lib/documents/encryption");
    const plain = Buffer.from("classified content for round-trip ✅");
    const { blob, keyReference } = encryptDocument(plain);
    expect(plain.includes(Buffer.from("classified"))).toBe(true);
    expect(blob.includes(Buffer.from("classified"))).toBe(false); // ciphertext at rest
    expect(keyReference).toMatch(/KEY|DEV/);
    expect(decryptDocument(blob).equals(plain)).toBe(true);
  });

  t("ciphertext is non-deterministic (fresh IV per encryption)", async () => {
    const { encryptDocument } = await import("@/lib/documents/encryption");
    const plain = Buffer.from("same input");
    const a = encryptDocument(plain).blob;
    const b = encryptDocument(plain).blob;
    expect(a.equals(b)).toBe(false);
  });

  t("tampered ciphertext fails authentication (fail closed)", async () => {
    const { encryptDocument, decryptDocument } = await import("@/lib/documents/encryption");
    const { blob } = encryptDocument(Buffer.from("integrity matters"));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptDocument(tampered)).toThrow();
  });

  t("SHA-256 integrity: calculate + verify match/mismatch", async () => {
    const { calculateSha256, verifyHash } = await import("@/lib/documents/integrity");
    const content = Buffer.from("fingerprint me");
    const h = calculateSha256(content);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyHash(content, h).match).toBe(true);
    expect(verifyHash(Buffer.from("modified"), h).match).toBe(false);
  });

  t("magic bytes decide MIME, not the browser declaration", async () => {
    const { validateUploadedFile, detectMimeType } = await import("@/lib/documents/validation");
    expect(detectMimeType(PNG_1PX)).toBe("image/png");
    expect(detectMimeType(makePdf(["x"]))).toBe("application/pdf");
    // text content named .png → signature mismatch
    expect(() =>
      validateUploadedFile({ originalFilename: "fake.png", declaredMimeType: "image/png", buffer: Buffer.from("just text") })
    ).toThrow(/signature mismatch|identified/);
    // valid PNG with lying declared MIME → rejected
    expect(() =>
      validateUploadedFile({ originalFilename: "img.png", declaredMimeType: "application/pdf", buffer: PNG_1PX })
    ).toThrow(/declared file type/);
    // valid path
    const ok = validateUploadedFile({ originalFilename: "img.png", declaredMimeType: "image/png", buffer: PNG_1PX });
    expect(ok.mimeType).toBe("image/png");
  });

  t("empty and binary-garbage files are rejected", async () => {
    const { validateUploadedFile } = await import("@/lib/documents/validation");
    expect(() => validateUploadedFile({ originalFilename: "a.pdf", declaredMimeType: "application/pdf", buffer: Buffer.alloc(0) })).toThrow(/empty/);
    expect(() => validateUploadedFile({ originalFilename: "a.pdf", declaredMimeType: "application/pdf", buffer: Buffer.from([0, 1, 2, 3, 255, 254]) })).toThrow();
  });

  t("disallowed extensions rejected (spec §13 whitelist)", async () => {
    const { validateUploadedFile } = await import("@/lib/documents/validation");
    expect(() =>
      validateUploadedFile({ originalFilename: "evil.exe", declaredMimeType: "application/octet-stream", buffer: Buffer.from("MZ—not really") })
    ).toThrow(/Unsupported file extension/);
  });

  t("oversized files rejected at the configured limit", async () => {
    const { validateUploadedFile } = await import("@/lib/documents/validation");
    const { DOCUMENT_MAX_BYTES } = await import("@/lib/constants");
    const big = Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0x41);
    expect(() => validateUploadedFile({ originalFilename: "big.txt", declaredMimeType: "text/plain", buffer: big })).toThrow(/maximum allowed size/);
  });

  t("original filename is sanitized; traversal components never survive", async () => {
    const { sanitizeOriginalFilename } = await import("@/lib/documents/validation");
    expect(sanitizeOriginalFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalFilename("..\\..\\windows\\system.ini")).toBe("system.ini");
    expect(sanitizeOriginalFilename("doc\u0000.pdf")).not.toContain("\u0000");
    expect(sanitizeOriginalFilename("a/b/c/../../file.pdf")).toBe("file.pdf");
  });

  t("security scanner stub: EICAR + MZ malicious, PDF scripts suspicious, clean safe", async () => {
    const { scanFileContent } = await import("@/lib/documents/scanner");
    expect(scanFileContent(Buffer.from(EICAR), "text/plain").verdict).toBe("MALICIOUS");
    expect(scanFileContent(Buffer.from("MZ" + "A".repeat(100)), "application/pdf").verdict).toBe("MALICIOUS");
    const sneaky = Buffer.concat([makePdf(["x"]), Buffer.from("/JavaScript (alert)")]);
    expect(scanFileContent(sneaky, "application/pdf").verdict).toBe("SUSPICIOUS");
    expect(scanFileContent(makePdf(["clean"]), "application/pdf").verdict).toBe("SAFE");
  });

  t("storage keys are opaque and traversal-proof", async () => {
    const { DocumentStorage } = await import("@/lib/documents/storage");
    await expect(DocumentStorage.get_object("../../etc/passwd")).rejects.toThrow();
    await expect(DocumentStorage.get_object("cases/x/documents/..%2f..%2f/object")).rejects.toThrow();
    await expect(DocumentStorage.get_object("cases/x/documents/../../secret/object")).rejects.toThrow();
    expect(await DocumentStorage.object_exists("cases/does-not-exist/documents/11111111-1111-1111-1111-111111111111/object")).toBe(false);
  });
});

// ============================================================
// B. Upload & validation (API) — spec §75
// ============================================================
describe("Phase 3 — upload & validation (API)", () => {
  t("valid PDF upload commits with DOC id, hash, encryption metadata", async () => {
    const res = await uploadDoc(officerPolice, CASE1, F, {
      title: "Phase 3 Valid PDF",
      documentType: "INVESTIGATION_REPORT",
      classification: "RESTRICTED",
      documentDate: "2026-09-20",
      tags: "phase3,test",
    });
    expect(res.status).toBe(201);
    const doc = officerPolice.data().document;
    expect(doc.id).toMatch(/^DOC-MP-IND-2026-\d{6}$/);
    expect(doc.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.status).toBe("COMMITTED");
    expect(doc.committedAt).toBeTruthy();
    expect(doc.encryptionStatus).toBe("ENCRYPTED_AES_256_GCM");
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.originalFilename).toBe("test.pdf");
    expect(doc.metadata.tags).toEqual(["phase3", "test"]);
    createdDocPublicIds.push(doc.id);
  });

  t("valid PNG and TXT uploads commit (server-detected MIME)", async () => {
    const png = await uploadDoc(officerPolice, CASE1, { name: "scan.png", type: "image/png", bytes: PNG_1PX }, {
      title: "Phase 3 PNG Exhibit", documentType: "EVIDENCE_REPORT", classification: "INTERNAL",
    });
    expect(png.status).toBe(201);
    expect(png.data().document.mimeType).toBe("image/png");
    createdDocPublicIds.push(png.data().document.id);

    const txt = await uploadDoc(officerPolice, CASE1, { name: "notes.txt", type: "text/plain", bytes: Buffer.from("plain notes") }, {
      title: "Phase 3 Notes", documentType: "CORRESPONDENCE", classification: "INTERNAL",
    });
    expect(txt.status).toBe(201);
    expect(txt.data().document.mimeType).toBe("text/plain");
    createdDocPublicIds.push(txt.data().document.id);
  });

  t("disallowed extension (.exe) → 415", async () => {
    const res = await uploadDoc(officerPolice, CASE1, { name: "tool.exe", type: "application/octet-stream", bytes: Buffer.from("MZ binary") }, {
      title: "Should Not Commit", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(415);
    expect(officerPolice.code()).toBe("UNSUPPORTED_FILE_TYPE");
  });

  t("wrong magic bytes (text posing as PNG) → 415", async () => {
    const res = await uploadDoc(officerPolice, CASE1, { name: "fake.png", type: "image/png", bytes: Buffer.from("definitely not a png") }, {
      title: "Fake PNG", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(415);
  });

  t("declared MIME contradicting content → 415", async () => {
    const res = await uploadDoc(officerPolice, CASE1, { name: "report.txt", type: "application/pdf", bytes: Buffer.from("plain text only") }, {
      title: "Declared Mismatch", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(415);
  });

  t("oversized file → 413 FILE_TOO_LARGE", async () => {
    const { DOCUMENT_MAX_BYTES } = await import("@/lib/constants");
    const big = Buffer.alloc(DOCUMENT_MAX_BYTES + 10, 0x41);
    const res = await uploadDoc(officerPolice, CASE1, { name: "big.txt", type: "text/plain", bytes: big }, {
      title: "Too Big", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(413);
    expect(officerPolice.code()).toBe("FILE_TOO_LARGE");
  });

  t("empty file → 422 and no document record", async () => {
    const before = (await officerPolice.get(`/api/v1/cases/${CASE1}/documents`)).data().total;
    const res = await uploadDoc(officerPolice, CASE1, { name: "empty.pdf", type: "application/pdf", bytes: Buffer.alloc(0) }, {
      title: "Empty", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(422);
    const after = (await officerPolice.get(`/api/v1/cases/${CASE1}/documents`)).data().total;
    expect(after).toBe(before);
  });

  t("malicious filename is neutralized (path traversal, separators, null byte)", async () => {
    const res = await uploadDoc(officerPolice, CASE1, { name: "../../evil\u0000.pdf", type: "application/pdf", bytes: F.bytes }, {
      title: "Traversal Name", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(201);
    expect(res.data().document.originalFilename).not.toContain("..");
    expect(res.data().document.originalFilename).not.toContain("/");
    expect(res.data().document.originalFilename).not.toContain("\u0000");
    createdDocPublicIds.push(res.data().document.id);
  });

  t("EICAR sample → 422 FILE_SCAN_FAILED and NO committed record", async () => {
    const before = (await officerPolice.get(`/api/v1/cases/${CASE1}/documents`)).data().total;
    const res = await uploadDoc(officerPolice, CASE1, { name: "eicar.txt", type: "text/plain", bytes: Buffer.from(EICAR) }, {
      title: "EICAR Test", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(422);
    expect(officerPolice.code()).toBe("FILE_SCAN_FAILED");
    const after = (await officerPolice.get(`/api/v1/cases/${CASE1}/documents`)).data().total;
    expect(after).toBe(before);
  });

  t("suspicious PDF (embedded script) → quarantined, invisible to officers, visible to SYSTEM_ADMIN", async () => {
    const sneaky = Buffer.concat([makePdf(["x"]), Buffer.from("/OpenAction << /S /JavaScript >>")]);
    const res = await uploadDoc(officerPolice, CASE1, { name: "sneaky.pdf", type: "application/pdf", bytes: sneaky }, {
      title: "Suspicious PDF", documentType: "OTHER", classification: "INTERNAL",
    });
    expect([202, 201]).toContain(res.status);
    expect(res.data().quarantined).toBe(true);
    expect(res.data().document.status).toBe("QUARANTINED");
    const quarantinedId = res.data().document.id;
    createdDocPublicIds.push(quarantinedId);

    const officerList = await officerPolice.get(`/api/v1/cases/${CASE1}/documents`);
    expect(officerList.data().items.some((d: any) => d.status === "QUARANTINED")).toBe(false);

    const sysList = await sys.get(`/api/v1/cases/${CASE1}/documents?status=QUARANTINED`);
    expect(sysList.data().items.some((d: any) => d.id === quarantinedId)).toBe(true);
  });

  t("HIGHLY_RESTRICTED assignment denied for ordinary officers (spec §7)", async () => {
    const res = await uploadDoc(officerPolice, CASE1, F, {
      title: "Officer Cannot Mint Top Classification", documentType: "OTHER", classification: "HIGHLY_RESTRICTED",
    });
    expect(res.status).toBe(403);
    expect(officerPolice.msg()).toMatch(/classification/i);
  });

  t("upload authorization: auditor (no permission), unrelated dept, unauthenticated", async () => {
    const a = await uploadDoc(auditor, CASE1, F, { title: "Auditor Upload", documentType: "OTHER", classification: "INTERNAL" });
    expect(a.status).toBe(403);

    const u = await uploadDoc(adminBhopal, CASE1, F, { title: "Unrelated Upload", documentType: "OTHER", classification: "INTERNAL" });
    expect(u.status).toBe(403);
    expect(u.code()).toBe("CASE_ACCESS_DENIED");

    const anonRes = await uploadDoc(anon, CASE1, F, { title: "Anon Upload", documentType: "OTHER", classification: "INTERNAL" });
    expect(anonRes.status).toBe(401);
  });

  t("upload to a CLOSED case → 403 (spec §57); viewing stays allowed", async () => {
    // CASE-MP-IND-2026-000004 is the seeded CLOSED case (police custodian).
    const res = await uploadDoc(adminPolice, "CASE-MP-IND-2026-000004", F, {
      title: "Closed Case Upload", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(res.status).toBe(403);
    expect(adminPolice.msg()).toMatch(/CLOSED|does not accept/i);
  });

  t("mass-assignment protection: client cannot set sha256/storageKey/status (spec §72)", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(F.bytes)], { type: "application/pdf" }), "mass.pdf");
    form.append("title", "Mass Assignment Attempt");
    form.append("documentType", "OTHER");
    form.append("classification", "INTERNAL");
    form.append("sha256Hash", "f".repeat(64));
    form.append("storageKey", "../../attacker/object");
    form.append("status", "COMMITTED");
    form.append("uploadedByOfficerId", "OFF-HACKED-000001");
    form.append("committedAt", "1999-01-01T00:00:00Z");
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents`, form);
    expect(res.status).toBe(201);
    const doc = officerPolice.data().document;
    expect(doc.sha256Hash).not.toBe("f".repeat(64));
    expect(doc.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(officerPolice.lastBody)).not.toContain("../../attacker/object");
    expect(doc.uploadedBy.officerId).toBe("OFF-MP-IND-00004"); // derived from session
    createdDocPublicIds.push(doc.id);
  });

  t("idempotency: retried clientRequestId does not double-commit (spec §68)", async () => {
    const clientRequestId = `idem-${stamp}`;
    const first = await uploadDoc(officerPolice, CASE1, F, {
      title: "Idempotent Upload", documentType: "OTHER", classification: "INTERNAL", clientRequestId,
    });
    expect(first.status).toBe(201);
    const second = await uploadDoc(officerPolice, CASE1, F, {
      title: "Idempotent Upload", documentType: "OTHER", classification: "INTERNAL", clientRequestId,
    });
    expect(second.status).toBe(200);
    expect(second.data().replayed).toBe(true);
    expect(second.data().document.id).toBe(first.data().document.id);
    createdDocPublicIds.push(first.data().document.id);
  });

  t("duplicate content in same case → warning, both records preserved (spec §67)", async () => {
    const first = await uploadDoc(officerPolice, CASE1, F, {
      title: "Duplicate Check A", documentType: "OTHER", classification: "INTERNAL", clientRequestId: `dup-a-${stamp}`,
    });
    const second = await uploadDoc(officerPolice, CASE1, F, {
      title: "Duplicate Check B", documentType: "OTHER", classification: "INTERNAL", clientRequestId: `dup-b-${stamp}`,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Hash is NOT a business identifier: identical content warns (pointing at
    // an earlier record with the same bytes) but never blocks or merges.
    expect(second.data().duplicateWarning).toBeTruthy();
    expect(second.data().duplicateWarning).not.toBe(second.data().document.id);
    expect(second.data().document.sha256Hash).toBe(first.data().document.sha256Hash);
    createdDocPublicIds.push(first.data().document.id, second.data().document.id);
  });
});

// ============================================================
// C. Immutability (spec §76) — CRITICAL
// ============================================================
describe("Phase 3 — immutability of committed documents", () => {
  let immDocId: string; // dedicated committed doc for this suite (run-order independent)
  let originalSnapshot: any;

  t("upload a dedicated document and capture its state", async () => {
    const res = await uploadDoc(officerPolice, CASE1, F, {
      title: "Immutability Specimen", documentType: "FIR", classification: "RESTRICTED",
      clientRequestId: `immut-${stamp}`,
    });
    expect(res.status).toBe(201);
    immDocId = res.data().document.id;
    createdDocPublicIds.push(immDocId);
    originalSnapshot = res.data();
    expect(originalSnapshot.document.status).toBe("COMMITTED");
  });

  t("PUT/PATCH/DELETE on a committed document are impossible (no mutation surface)", async () => {
    const put = await officerPolice.put(`/api/v1/cases/${CASE1}/documents/${immDocId}`, { title: "hacked" });
    expect([405, 404]).toContain(put.status);
    const patch = await officerPolice.patch(`/api/v1/cases/${CASE1}/documents/${immDocId}`, { sha256Hash: "0".repeat(64) });
    expect([405, 404]).toContain(patch.status);
    const del = await officerPolice.del(`/api/v1/cases/${CASE1}/documents/${immDocId}`);
    expect([405, 404]).toContain(del.status);
    // arbitrary file overwrite endpoint does not exist
    const putFile = await officerPolice.put(`/api/v1/cases/${CASE1}/documents/${immDocId}/file`, {});
    expect([405, 404]).toContain(putFile.status);
  });

  t("creating a correction leaves the original byte-for-byte unchanged", async () => {
    const res = await uploadRelated(officerPolice, CASE1, immDocId, "correction", F, {
      title: "Correction to Specimen",
      documentType: "FIR",
      classification: "RESTRICTED",
      clientRequestId: `corr-${stamp}`,
    });
    expect(res.status).toBe(201);
    const correction = res.data().document;
    createdDocPublicIds.push(correction.id);

    const after = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${immDocId}`);
    const doc = after.data().document;
    expect(doc.sha256Hash).toBe(originalSnapshot.document.sha256Hash);
    expect(doc.title).toBe(originalSnapshot.document.title);
    expect(doc.originalFilename).toBe(originalSnapshot.document.originalFilename);
    expect(doc.uploadedBy.officerId).toBe(originalSnapshot.document.uploadedBy.officerId);
    expect(doc.status).toBe("COMMITTED"); // corrections do NOT supersede
    expect(after.data().relationships.incoming.some((r: any) => r.relationshipType === "CORRECTION")).toBe(true);
  });

  t("supplement and replacement workflows (spec §37-§39)", async () => {
    // supplement
    const sup = await uploadRelated(officerPolice, CASE1, immDocId, "supplement", F, {
      documentType: "FIR", classification: "INTERNAL", clientRequestId: `sup-${stamp}`,
    });
    expect(sup.status).toBe(201);
    createdDocPublicIds.push(sup.data().document.id);

    // replacement of a committed doc → original SUPERSEDED but intact
    const rep = await uploadRelated(officerPolice, CASE1, immDocId, "replacement", F, {
      documentType: "FIR", classification: "RESTRICTED", clientRequestId: `rep-${stamp}`,
    });
    expect(rep.status).toBe(201);
    expect(rep.data().supersededTarget).toBe(true);
    const replacementId = rep.data().document.id;
    createdDocPublicIds.push(replacementId);

    const original = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${immDocId}`);
    expect(original.data().document.status).toBe("SUPERSEDED");
    expect(original.data().document.supersededByDocumentId).toBe(replacementId);
    expect(original.data().document.sha256Hash).toBe(originalSnapshot.document.sha256Hash); // content untouched
    // superseded original remains downloadable per authorization policy
    const dl = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${immDocId}/download`);
    expect(dl.status).toBe(200);
  });

  t("replacement of an already-superseded document → 409", async () => {
    const res = await uploadRelated(officerPolice, CASE1, immDocId, "replacement", F, {
      documentType: "FIR", classification: "RESTRICTED", clientRequestId: `rep2-${stamp}`,
    });
    expect(res.status).toBe(409);
    expect(officerPolice.code()).toBe("INVALID_DOCUMENT_STATE");
  });

  t("controlled integrity verification: SYSTEM_ADMIN ok, others denied (spec §21)", async () => {
    const sysRes = await sys.post(`/api/v1/cases/${CASE1}/documents/${immDocId}/verify`);
    expect(sysRes.status).toBe(200);
    expect(sysRes.data().match).toBe(true);
    expect(sysRes.data().computedHash).toBe(originalSnapshot.document.sha256Hash);

    const offRes = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${immDocId}/verify`);
    expect(offRes.status).toBe(403);
  });
});

// ============================================================
// D. Access-control matrix (spec §77) — case 1: police custodian
//    (arjun admin assigned, vishnu officer assigned), FSL
//    participating (unassigned), auditor, unrelated dept.
// ============================================================
describe("Phase 3 — access control matrix", () => {
  t("assigned custodian officer: full visibility incl. CONFIDENTIAL + RESTRICTED", async () => {
    const res = await officerPolice.get(`/api/v1/cases/${CASE1}/documents`);
    expect(res.status).toBe(200);
    expect(res.data().canUpload).toBe(true);
    const conf = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?classification=CONFIDENTIAL`);
    expect(conf.data().total).toBeGreaterThanOrEqual(1); // seeded CONFIDENTIAL report visible
    const restr = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?classification=RESTRICTED`);
    expect(restr.data().total).toBeGreaterThanOrEqual(1);
  });

  t("custodian department admin: manage authority", async () => {
    const res = await adminPolice.get(`/api/v1/cases/${CASE1}/documents`);
    expect(res.status).toBe(200);
    expect(res.data().canUpload).toBe(true);
  });

  t("participating department (unassigned): INTERNAL-only visibility, no upload hint", async () => {
    const res = await adminFsl.get(`/api/v1/cases/${CASE1}/documents`);
    expect(res.status).toBe(200); // case-level view via participation
    expect(res.data().canUpload).toBe(false);
    for (const d of res.data().items) {
      expect(d.classification).toBe("INTERNAL"); // higher classifications filtered in the QUERY (spec §64)
    }
    const conf = await adminFsl.get(`/api/v1/cases/${CASE1}/documents?classification=CONFIDENTIAL`);
    expect(conf.status).toBe(200);
    expect(conf.data().total).toBe(0); // never receives metadata for unauthorized documents
  });

  t("classification denies direct access even with case access (spec §24)", async () => {
    const res = await adminFsl.get(`/api/v1/cases/${CASE1}/documents/${DOC1}`); // RESTRICTED
    expect(res.status).toBe(403);
    expect(adminFsl.code()).toBe("DOCUMENT_ACCESS_DENIED");
    const view = await adminFsl.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/view`);
    expect(view.status).toBe(403);
    const dl = await adminFsl.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/download`);
    expect(dl.status).toBe(403);
  });

  t("auditor: read-only up to RESTRICTED, no upload", async () => {
    const res = await auditor.get(`/api/v1/cases/${CASE1}/documents`);
    expect(res.status).toBe(200);
    expect(res.data().canUpload).toBe(false);
    expect(res.data().items.length).toBeGreaterThanOrEqual(4);
    const dl = await auditor.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/download`);
    expect(dl.status).toBe(200);
    const up = await uploadDoc(auditor, CASE1, F, { title: "Nope", documentType: "OTHER", classification: "INTERNAL" });
    expect(up.status).toBe(403);
  });

  t("unrelated department: nothing exists for them (spec §64)", async () => {
    const list = await adminBhopal.get(`/api/v1/cases/${CASE1}/documents`);
    expect(list.status).toBe(403);
    const view = await adminBhopal.get(`/api/v1/cases/${CASE1}/documents/${DOC1}`);
    expect(view.status).toBe(403);
    const dl = await adminBhopal.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/download`);
    expect(dl.status).toBe(403);
  });

  t("unauthenticated: 401 across the document surface", async () => {
    expect((await anon.get(`/api/v1/cases/${CASE1}/documents`)).status).toBe(401);
    expect((await anon.get(`/api/v1/cases/${CASE1}/documents/${DOC1}`)).status).toBe(401);
    expect((await anon.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/view`)).status).toBe(401);
    expect((await anon.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/download`)).status).toBe(401);
  });

  t("nonexistent document and wrong case/document combination → 404 (spec §78)", async () => {
    const missing = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/DOC-MP-IND-2026-999999`);
    expect(missing.status).toBe(404);
    expect(officerPolice.code()).toBe("DOCUMENT_NOT_FOUND");
    // DOC-1 does not belong to case 2
    const wrong = await adminFsl.get(`/api/v1/cases/CASE-MP-IND-2026-000002/documents/${DOC1}`);
    expect([403, 404]).toContain(wrong.status);
  });
});

// ============================================================
// E. Custody transfer rules (spec §55/§81 steps 17-21)
// ============================================================
describe("Phase 3 — custody transfer changes authority, not history", () => {
  let caseRef: string; // public id
  let uploadedDocId: string;
  let uploadedInternalDocId: string;

  t("setup: police creates case, uploads (RESTRICTED + INTERNAL), requests transfer to FSL, FSL accepts", async () => {
    const created = await createTestCase(adminPolice, { title: `Custody Transfer Doc Case ${stamp}` });
    expect(created.status).toBe(201);
    caseRef = adminPolice.data().caseId;

    const up = await uploadDoc(adminPolice, caseRef, F, {
      title: "Evidence Before Transfer", documentType: "EVIDENCE_REPORT", classification: "RESTRICTED",
    });
    expect(up.status).toBe(201);
    uploadedDocId = up.data().document.id;

    const upInternal = await uploadDoc(adminPolice, caseRef, { name: "internal-notes.txt", type: "text/plain", bytes: Buffer.from("internal working notes") }, {
      title: "Working Notes Before Transfer", documentType: "CORRESPONDENCE", classification: "INTERNAL",
    });
    expect(upInternal.status).toBe(201);
    uploadedInternalDocId = upInternal.data().document.id;

    const depts = await adminPolice.get("/api/v1/departments?page=1&pageSize=100");
    const fslId = depts.data().items.find((d: any) => d.departmentCode === "DEPT-MP-IND-FSL-001").id;
    const trf = await adminPolice.post(`/api/v1/cases/${caseRef}/transfers`, {
      toDepartmentId: fslId, reason: "Forensic examination required (phase 3 test).",
    });
    expect(trf.status).toBe(201);

    const accept = await adminFsl.post(`/api/v1/cases/${caseRef}/transfers/${trf.data().transferId}/accept`);
    expect(accept.status).toBe(200);
  });

  t("new custodian (FSL) gains document-management authority", async () => {
    const res = await uploadDoc(adminFsl, caseRef, F, {
      title: "FSL Findings After Custody", documentType: "FORENSIC_REPORT", classification: "RESTRICTED",
      clientRequestId: `fsl-post-transfer-${stamp}`,
    });
    expect(res.status).toBe(201);
    createdDocPublicIds.push(res.data().document.id);
  });

  t("previous custodian loses upload authority but keeps historical read (spec §55)", async () => {
    const upAttempt = await uploadDoc(adminPolice, caseRef, F, {
      title: "Police Should Not Upload", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(upAttempt.status).toBe(403);

    const originalUploaderAttempt = await uploadDoc(officerPolice, caseRef, F, {
      title: "Vishnu Should Not Upload", documentType: "OTHER", classification: "INTERNAL",
    });
    expect(originalUploaderAttempt.status).toBe(403);

    // Historical READ access is retained — but classification still applies:
    // the origin-side actor sees INTERNAL documents, not RESTRICTED ones.
    const view = await adminPolice.get(`/api/v1/cases/${caseRef}/documents`);
    expect(view.status).toBe(200); // historical read retained
    expect(view.data().items.some((d: any) => d.id === uploadedInternalDocId)).toBe(true);
    expect(view.data().items.some((d: any) => d.id === uploadedDocId)).toBe(false); // RESTRICTED filtered by classification

    const dlInternal = await adminPolice.get(`/api/v1/cases/${caseRef}/documents/${uploadedInternalDocId}/download`);
    expect(dlInternal.status).toBe(200);
    const dlRestricted = await adminPolice.get(`/api/v1/cases/${caseRef}/documents/${uploadedDocId}/download`);
    expect(dlRestricted.status).toBe(403);
    expect(adminPolice.code()).toBe("DOCUMENT_ACCESS_DENIED");
  });

  t("uploaded-by identity and document remain immutable across custody change", async () => {
    const res = await adminFsl.get(`/api/v1/cases/${caseRef}/documents/${uploadedDocId}`);
    expect(res.status).toBe(200);
    expect(res.data().document.uploadedBy.officerId).toBe("OFF-MP-IND-00001"); // original uploader preserved
    expect(res.data().document.department.departmentCode).toBe("DEPT-MP-IND-POL-001");
  });
});

// ============================================================
// F. Relationships (spec §79)
// ============================================================
describe("Phase 3 — relationship rules", () => {
  t("RELATED link between two existing documents", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: "DOC-MP-IND-2026-000002",
      relationshipType: "RELATED",
    });
    // 201 on a fresh database; 409 when the suite re-runs on a database that
    // already holds this link (duplicate rejection is asserted explicitly below).
    expect([201, 409]).toContain(res.status);
    // The link must exist either way.
    const check = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`);
    expect(
      check.data().relationships.some(
        (r: any) => r.relationshipType === "RELATED" && r.counterpart?.documentId === "DOC-MP-IND-2026-000002"
      )
    ).toBe(true);
  });

  t("self relationship → 422", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: DOC1, relationshipType: "RELATED",
    });
    expect(res.status).toBe(422);
    expect(officerPolice.code()).toBe("INVALID_RELATIONSHIP");
  });

  t("duplicate relationship → 409", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: "DOC-MP-IND-2026-000002", relationshipType: "RELATED",
    });
    expect(res.status).toBe(409);
  });

  t("nonexistent target → 404", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: "DOC-MP-IND-2026-999999", relationshipType: "REFERENCE",
    });
    expect(res.status).toBe(404);
  });

  t("cross-case relationship rejected (target not in this case)", async () => {
    // create a doc on a fresh case, then try to link it from case 1
    const other = await createTestCase(adminPolice, { title: `Cross-case Link ${stamp}` });
    expect(other.status).toBe(201);
    const otherRef = adminPolice.data().caseId;
    const up = await uploadDoc(adminPolice, otherRef, F, {
      title: "Other Case Doc", documentType: "OTHER", classification: "INTERNAL",
    });
    createdDocPublicIds.push(up.data().document.id);
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: up.data().document.id, relationshipType: "RELATED",
    });
    expect(res.status).toBe(404); // not found in case 1 — cross-case linking impossible
  });

  t("SUPPLEMENT/REPLACEMENT types rejected through the generic link endpoint", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: "DOC-MP-IND-2026-000002", relationshipType: "SUPPLEMENT",
    });
    expect(res.status).toBe(422); // zod enum violation
  });

  t("relationship creation requires custodian authority (spec §77)", async () => {
    const res = await adminFsl.post(`/api/v1/cases/${CASE1}/documents/DOC-MP-IND-2026-000004/relationships`, {
      targetDocumentId: DOC1, relationshipType: "REFERENCE",
    });
    expect(res.status).toBe(403);
    const aud = await auditor.post(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`, {
      targetDocumentId: "DOC-MP-IND-2026-000002", relationshipType: "REFERENCE",
    });
    expect(aud.status).toBe(403);
  });

  t("GET relationships returns both directions with counterpart summaries", async () => {
    const res = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/relationships`);
    expect(res.status).toBe(200);
    const rels = officerPolice.data().relationships;
    expect(rels.length).toBeGreaterThanOrEqual(1);
    expect(rels.some((r: any) => r.relationshipType === "RELATED" && r.direction === "outgoing"
      && r.counterpart?.documentId === "DOC-MP-IND-2026-000002")).toBe(true);
  });
});

// ============================================================
// G. Events, search & download audit (spec §32/§33/§41/§51/§78)
// ============================================================
describe("Phase 3 — events, audit and search", () => {
  t("view + download generate the spec event sequence", async () => {
    await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/view`);
    await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/download`);
    const res = await officerPolice.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/events`);
    expect(res.status).toBe(200);
    const types = officerPolice.data().events.map((e: any) => e.eventType);
    expect(types).toContain("DOCUMENT_COMMITTED");
    expect(types).toContain("DOCUMENT_VIEWED");
    expect(types).toContain("DOCUMENT_DOWNLOAD_REQUESTED");
    expect(types).toContain("DOCUMENT_DOWNLOAD_COMPLETED");
  });

  t("denied access is audited as DOCUMENT_ACCESS_DENIED", async () => {
    await adminFsl.get(`/api/v1/cases/${CASE1}/documents/${DOC1}`); // denied (classification)
    const sysRes = await sys.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/events`);
    const types = sysRes.data().events.map((e: any) => e.eventType);
    expect(types).toContain("DOCUMENT_ACCESS_DENIED");
  });

  t("events never contain document content or keys", async () => {
    const res = await sys.get(`/api/v1/cases/${CASE1}/documents/${DOC1}/events`);
    const raw = JSON.stringify(sys.lastBody);
    expect(raw).not.toContain("%PDF");
    expect(raw).not.toContain("ENC1");
    expect(raw).not.toContain("storageKey");
    expect(raw.toLowerCase()).not.toContain("aeskey");
  });

  t("document events flow into the case timeline", async () => {
    const res = await officerPolice.get(`/api/v1/cases/${CASE1}/timeline`);
    expect(res.status).toBe(200);
    const types = officerPolice.data().items.map((e: any) => e.eventType);
    expect(types).toContain("DOCUMENT_COMMITTED");
  });

  t("search: q matches title/filename/document id/reference (spec §41)", async () => {
    const byRef = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?q=${encodeURIComponent("FIR/124")}`);
    expect(byRef.status).toBe(200);
    expect(byRef.data().items.some((d: any) => d.id === DOC1)).toBe(true);
    const byId = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?q=DOC-MP-IND-2026-000003`);
    expect(byId.data().items.length).toBe(1);
    expect(byId.data().items[0].id).toBe("DOC-MP-IND-2026-000003");
  });

  t("filters: type, classification, department + pagination", async () => {
    const fir = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?type=FIR`);
    expect(fir.data().items.every((d: any) => d.documentType === "FIR")).toBe(true);
    expect(fir.data().items.length).toBeGreaterThanOrEqual(1);

    const internal = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?classification=INTERNAL`);
    expect(internal.data().items.every((d: any) => d.classification === "INTERNAL")).toBe(true);

    const paged = await officerPolice.get(`/api/v1/cases/${CASE1}/documents?page=1&pageSize=2`);
    expect(paged.data().items.length).toBe(2);
    expect(paged.data().total).toBeGreaterThanOrEqual(4);
    expect(paged.data().page).toBe(1);
  });

  t("case list response never exposes storage internals (spec §30/§64)", async () => {
    const res = await sys.get(`/api/v1/cases/${CASE1}/documents`);
    const raw = JSON.stringify(sys.lastBody);
    expect(raw).not.toContain("storageKey");
    expect(raw).not.toContain("keyReference");
    expect(raw).not.toContain("storedFilename");
    expect(raw).not.toContain("/documents/");
    void res;
  });
});
