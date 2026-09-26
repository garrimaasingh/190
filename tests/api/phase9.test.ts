/**
 * Phase 9 API & security test suite — Manual Import/Export + Interoperability Fallback.
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase9.test.ts
 *
 * Covers spec §2-§85 highlights: package format determinism + integrity,
 * ZIP security (zip-slip §68, archive bombs §69), package tampering §67,
 * duplicate packages §70, immutable document protection §71, evidence
 * custody boundary §72, classification downgrade protection §73, forged
 * importer identity §74, expired package download denial §75, malicious
 * file rejection §76, unauthorized export §66, two-person separation of
 * duties §40, partial import §45, conflicts §36/§37, Phase 5/6/8 reuse
 * (§61-§63), the §77 end-to-end demonstration, and audit-chain integrity.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { verifyChain } from "@/lib/audit/integrity";
import {
  buildPackage,
  parsePackage,
  canonicalize,
  canonicalSha256,
  ZipFormatError,
  type PackageDraft,
  type DocumentPayload,
  type EvidencePayload,
  type RelationshipPayload,
  type CasePayload,
} from "@/lib/interop/package-format";
import { buildZip, readZipSecure, normalizePackagePath, sha256Hex, crc32, ZipFormatError as ZipError } from "@/lib/interop/zip";

const BASE = "http://localhost:3000";
function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 120000);
}
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a", connection: "close" };

// ---------- HTTP client ----------
class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = { ...BYPASS, ...(extraHeaders || {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const send = () => fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let res = await send();
    if (res.status >= 500) res = await send();
    this.lastStatus = res.status;
    try {
      this.lastBody = await res.json();
    } catch {
      this.lastBody = null;
    }
    return this.lastBody;
  }

  /** Multipart upload of a raw archive buffer. */
  async uploadPackage(path: string, archive: Buffer, filename = "package.zip", purpose?: string) {
    const form = new FormData();
    form.append("package", new Blob([new Uint8Array(archive)]), filename);
    if (purpose) form.append("purpose", purpose);
    const headers: Record<string, string> = { ...BYPASS };
    if (this.cookie) headers["Cookie"] = this.cookie;
    const send = () => fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
    let res = await send();
    if (res.status >= 500) res = await send();
    this.lastStatus = res.status;
    try {
      this.lastBody = await res.json();
    } catch {
      this.lastBody = null;
    }
    return this.lastBody;
  }

  /** Raw binary download (returns bytes + status, no JSON parse). */
  async download(path: string) {
    const headers: Record<string, string> = { ...BYPASS };
    if (this.cookie) headers["Cookie"] = this.cookie;
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers });
    this.lastStatus = res.status;
    if (res.status !== 200) {
      try {
        this.lastBody = await res.json();
      } catch {
        this.lastBody = null;
      }
      return { bytes: null, sha256: null };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, sha256: res.headers.get("x-package-sha256") };
  }

  async login(email: string) {
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
let arjun: Client; // police DEPARTMENT_ADMIN — owns/works seeded case 1
let meera: Client; // FSL DEPARTMENT_ADMIN — different department
let vishnu: Client; // police OFFICER — interop.read only
let priya: Client; // AUDITOR — read-only

const SOURCE_CENTRAL = "Central Case Platform";
const SOURCE_LEGACY = "Legacy Records System";

// ---------- helpers ----------

function pdfBytes(seed: string): Buffer {
  // Minimal PDF-shaped payload: %PDF magic header + deterministic filler.
  return Buffer.concat([Buffer.from(`%PDF-1.4\n${seed}\n`, "utf8"), Buffer.alloc(64, seed.charCodeAt(0))]);
}

let pkgSeq = 0;
function nextPackageId(): string {
  pkgSeq += 1;
  return `PKG-MP-IND-2099-${String(pkgSeq).padStart(6, "0")}`;
}

function makeDraft(opts: {
  sourceSystem: string;
  externalCaseId: string;
  docs: { id: string; seed: string; classification?: string; title?: string }[];
  evidence?: { id: string; title: string; classification?: string; custodyTrail?: boolean }[];
  relationships?: { id: string; sourceId: string; targetId: string; type?: string; provenance: "AUTHORITATIVE_IMPORT" | "IMPORTED_REFERENCE" }[];
  caseTitle?: string;
  packageType?: PackageDraft["manifest"] extends { package_type: infer P } ? P : never;
}): PackageDraft {
  const casePayload: CasePayload = {
    case_id: opts.externalCaseId,
    title: opts.caseTitle ?? `External case ${opts.externalCaseId}`,
    case_type: "THEFT",
    priority: "NORMAL",
    status: "OPEN",
    geography: { country: "India", state: "Madhya Pradesh", district: "Indore", city: "Indore" },
  };
  const documents = opts.docs.map((d) => {
    const binary = pdfBytes(d.seed);
    const payload: DocumentPayload = {
      document_id: d.id,
      case_id: opts.externalCaseId,
      title: d.title ?? `Doc ${d.id}`,
      document_type: "FIR",
      classification: d.classification ?? "RESTRICTED",
      original_filename: `${d.id}.pdf`,
      mime_type: "application/pdf",
      size: binary.length,
      sha256: sha256Hex(binary),
      has_binary: false,
      binary_path: null,
    };
    return { payload, binary };
  });
  const evidence = (opts.evidence ?? []).map((e) => {
    const payload: EvidencePayload = {
      evidence_id: e.id,
      case_id: opts.externalCaseId,
      title: e.title,
      evidence_type: "PHYSICAL",
      classification: e.classification ?? "RESTRICTED",
      status: "IN_CUSTODY",
      has_binary: false,
      binary_path: null,
      custody_history_available: !!e.custodyTrail,
      custody_trail: e.custodyTrail
        ? [{ transfer_id: "EXT-TR-1", from_department: "External Police", to_department: "External Forensics", requesting_officer: "Ext Officer A", accepting_officer: "Ext Officer B", timestamp: new Date().toISOString(), reason: "Examination request", status: "ACCEPTED" }]
        : null,
    };
    return { payload, binary: undefined };
  });
  const relationships = (opts.relationships ?? []).map(
    (r): RelationshipPayload => ({
      relationship_id: r.id,
      source_type: "DOCUMENT",
      source_id: r.sourceId,
      target_type: "DOCUMENT",
      target_id: r.targetId,
      relationship_type: r.type ?? "RELATED",
      provenance: r.provenance,
    })
  );
  return {
    manifest: {
      package_id: nextPackageId(), // unique per synthetic package (§5: IDs are never reused)
      package_type: "FULL_CASE_EXPORT",
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      created_by: "External Records Clerk",
      source_system: opts.sourceSystem,
      source_department: "External Department",
      case_count: 1,
      document_count: documents.length,
      evidence_count: evidence.length,
      relationship_count: relationships.length,
      integrity_algorithm: "SHA-256",
      integrity_manifest_reference: "integrity.json",
    },
    metadata: { case_reference: opts.externalCaseId, classification: "RESTRICTED", record_counts: { cases: 1, documents: documents.length, evidence: evidence.length, relationships: relationships.length } },
    case: casePayload,
    documents,
    evidence,
    relationships,
  };
}

/** Craft a raw ZIP containing a single entry with an arbitrary path (for zip-slip). */
function craftZipWithEntry(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE((1 << 5) | 1, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE((1 << 5) | 1, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

/** Competent tamperer: flip payload bytes AND recompute both CRCs so only the
 *  SHA-256 integrity manifest stands between the package and the importer. */
function tamperBinary(zip: Buffer, marker: Buffer): Buffer {
  const idx = zip.indexOf(marker);
  if (idx < 0) throw new Error("marker not found");
  const copy = Buffer.from(zip);
  copy[idx] = copy[idx] ^ 0xff;
  const newCrc = crc32(copy.subarray(idx, idx + marker.length));
  const nameLen = copy.readUInt16LE(idx - 30 - 0 + 0) === 0 ? 0 : 0; // resolved below
  // local header: scan backwards for PK\x03\x04 within 300 bytes
  let localOff = -1;
  for (let i = idx - 1; i > Math.max(0, idx - 512); i--) {
    if (copy.readUInt32LE(i) === 0x04034b50) {
      localOff = i;
      break;
    }
  }
  if (localOff < 0) throw new Error("local header not found");
  copy.writeUInt32LE(newCrc, localOff + 14);
  // central directory entry
  let cdOff = -1;
  for (let i = localOff + marker.length; i < copy.length - 22; i++) {
    if (copy.readUInt32LE(i) === 0x02014b50) {
      cdOff = i;
      break;
    }
  }
  if (cdOff >= 0) copy.writeUInt32LE(newCrc, cdOff + 16);
  return copy;
}

let case1Ref = "CASE-MP-IND-2026-000001";
let exportedJobId: string;
let exportedPackageId: string;
let exportedZip: Buffer;
let importedCentralCaseRef: string | null = null;

beforeAll(async () => {
  sysadmin = new Client();
  arjun = new Client();
  meera = new Client();
  vishnu = new Client();
  priya = new Client();
  await sysadmin.login("sysadmin@demo.gov.in");
  await arjun.login("arjun.sharma@demo.gov.in");
  await meera.login("meera.desai@demo.gov.in");
  await vishnu.login("vishnu.kumar@demo.gov.in");
  await priya.login("priya.nair@demo.gov.in");
});

// ============================================================
// 1) Unit — package format + canonical integrity (§2-§15)
// ============================================================
describe("Phase 9 — package format (unit)", () => {
  t("canonicalize is deterministic and key-sorted (§14)", () => {
    const a = canonicalize({ b: 2, a: { d: [3, { z: 1, y: 2 }], c: 4 } });
    const b = canonicalize({ a: { c: 4, d: [3, { y: 2, z: 1 }] }, b: 2 });
    expect(a).toBe(b);
    expect(a).not.toContain(" ");
    expect(canonicalSha256({ x: 1 })).toBe(canonicalSha256({ x: 1 }));
  });

  t("build → parse round-trip verifies every file hash (§13)", () => {
    const built = buildPackage(makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-UT-1", docs: [{ id: "EXT-DOC-U1", seed: "unit" }] }));
    const parsed = parsePackage(built.zip);
    expect(parsed.manifest.package_type).toBe("FULL_CASE_EXPORT");
    expect(parsed.documents[0].binary?.toString()).toContain("%PDF-1.4");
    expect(parsed.integrityCanonicalSha256).toBe(built.integrityCanonicalSha256);
  });

  t("identical drafts produce byte-identical archives (determinism)", () => {
    const draft = makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-UT-2", docs: [{ id: "D1", seed: "x" }] });
    const a = buildPackage(structuredClone(draft));
    const b = buildPackage(structuredClone(draft));
    expect(a.zip.equals(b.zip)).toBe(true);
  });

  t("competent tampering (CRC recomputed) is caught by the integrity manifest (§67)", () => {
    const built = buildPackage(makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-UT-3", docs: [{ id: "D1", seed: "tamper-me" }] }));
    const tampered = tamperBinary(built.zip, pdfBytes("tamper-me"));
    expect(() => parsePackage(tampered)).toThrow(ZipFormatError);
    try {
      parsePackage(tampered);
    } catch (err) {
      expect((err as ZipFormatError).code).toBe("PACKAGE_TAMPERED");
    }
  });

  t("zip-slip paths are rejected (§26/§68)", () => {
    for (const p of ["../../evil.txt", "..\\..\\evil.txt", "/etc/passwd", "C:/Windows/evil", "ok/../../up", "a/./b"]) {
      expect(() => normalizePackagePath(p, 3)).toThrow(ZipError);
    }
    expect(normalizePackagePath("documents/D1/binary.pdf", 3)).toBe("documents/D1/binary.pdf");
  });

  t("oversized declared entry is rejected BEFORE inflation (§69)", () => {
    const zip = buildZip([{ path: "a.txt", data: Buffer.from("real") }]);
    const cdIdx = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0xffffff00, cdIdx + 24);
    expect(() =>
      readZipSecure(zip, { maxCompressedBytes: 1e8, maxUncompressedBytes: 5e8, maxFileBytes: 5e7, maxFiles: 500, maxCompressionRatio: 200, maxDepth: 3 })
    ).toThrow(ZipError);
  });

  t("unsupported schema version is refused (§3)", () => {
    const draft = makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-UT-4", docs: [{ id: "D1", seed: "x" }] });
    (draft.manifest as { schema_version: string }).schema_version = "9.9";
    const built = buildPackage(draft);
    try {
      parsePackage(built.zip);
      throw new Error("should have been refused");
    } catch (err) {
      expect((err as ZipFormatError).code).toBe("PACKAGE_SCHEMA_UNSUPPORTED");
    }
  });

  t("manifest counts mismatch is detected", () => {
    const draft = makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-UT-5", docs: [{ id: "D1", seed: "x" }] });
    draft.manifest.document_count = 7;
    const built = buildPackage(draft);
    try {
      parsePackage(built.zip);
      throw new Error("should have been refused");
    } catch (err) {
      expect((err as ZipFormatError).code).toBe("PACKAGE_MANIFEST_MISMATCH");
    }
  });
});

// ============================================================
// 2) Authorization (§65/§66)
// ============================================================
describe("Phase 9 — authorization", () => {
  t("anonymous export attempt → 401", async () => {
    const anon = new Client();
    await anon.req("POST", "/api/v1/interoperability/exports", { caseRef: case1Ref, packageType: "FULL_CASE_EXPORT" });
    expect(anon.lastStatus).toBe(401);
  });

  t("OFFICER has interop.read but NOT export → 403 on export, 200 on list (§65)", async () => {
    await vishnu.req("POST", "/api/v1/interoperability/exports", { caseRef: case1Ref, packageType: "FULL_CASE_EXPORT" });
    expect(vishnu.lastStatus).toBe(403);
    await vishnu.req("GET", "/api/v1/interoperability/exports");
    expect(vishnu.lastStatus).toBe(200);
  });

  t("AUDITOR is read-only — export refused → 403 (§38 mirror)", async () => {
    await priya.req("POST", "/api/v1/interoperability/exports", { caseRef: case1Ref, packageType: "FULL_CASE_EXPORT" });
    expect(priya.lastStatus).toBe(403);
    await priya.req("GET", "/api/v1/interoperability/exports");
    expect(priya.lastStatus).toBe(200);
  });

  t("unauthorized case access → 403 CASE_ACCESS_DENIED with audited denial", async () => {
    // find a case where FSL (meera) has no participation/custody
    const fsl = await db.department.findFirst({ where: { name: { contains: "Forensic" } } });
    expect(fsl).toBeTruthy();
    const cases = await db.case.findMany({
      include: { departments: true },
    });
    const noAccess = cases.find(
      (c) => c.currentCustodianDepartmentId !== fsl!.id && !c.departments.some((d) => d.departmentId === fsl!.id)
    );
    expect(noAccess).toBeTruthy();
    await meera.req("GET", `/api/v1/interoperability/exports/preview?caseRef=${noAccess!.caseId}`);
    expect(meera.lastStatus).toBe(403);
    const denial = await db.auditEvent.findFirst({ where: { eventType: "MANUAL_EXPORT_FAILED", metadata: { contains: "CASE_ACCESS_DENIED" } }, orderBy: { sequence: "desc" } });
    expect(denial).toBeTruthy();
  });

  t("arjun preview of case 1 shows the exact authorized scope (§56)", async () => {
    await arjun.req("GET", `/api/v1/interoperability/exports/preview?caseRef=${case1Ref}`);
    expect(arjun.lastStatus).toBe(200);
    expect(arjun.lastBody.data.documents.length).toBeGreaterThan(0);
    expect(typeof arjun.lastBody.data.documents[0].selectable).toBe("boolean");
    expect(arjun.lastBody.data.interopNote).toContain("not a live system integration");
  });
});

// ============================================================
// 3) Export job flow (§16-§22/§48/§52)
// ============================================================
describe("Phase 9 — export flow", () => {
  t("FULL_CASE_EXPORT builds a downloadable package with integrity facts", async () => {
    await arjun.req("POST", "/api/v1/interoperability/exports", {
      caseRef: case1Ref,
      packageType: "FULL_CASE_EXPORT",
      includeAuditEvents: true,
      purpose: "Phase 9 E2E export",
    });
    expect(arjun.lastStatus).toBe(200);
    exportedJobId = arjun.lastBody.data.job.jobId;
    exportedPackageId = arjun.lastBody.data.packageId;
    expect(exportedPackageId).toMatch(/^PKG-MP-IND-\d{4}-\d{6}$/);
    expect(arjun.lastBody.data.job.status).toBe("COMPLETED");
    expect(arjun.lastBody.data.job.recordCounts.documents).toBeGreaterThan(0);
    expect(arjun.lastBody.data.job.recordCounts.evidence).toBeGreaterThan(0);
    // §48 — package classification at least as restrictive as the records
    expect(["CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"]).toContain(arjun.lastBody.data.job.classification);
  });

  t("package inspector exposes identity/hashes but never payload contents (§58)", async () => {
    await sysadmin.req("GET", `/api/v1/interoperability/exports/${exportedJobId}`);
    expect(sysadmin.lastStatus).toBe(200);
    const pkg = sysadmin.lastBody.data.package;
    expect(pkg.packageId).toBe(exportedPackageId);
    expect(pkg.packageSha256).toHaveLength(64);
    expect(pkg.manifestHash).toHaveLength(64);
    expect(pkg.integrityChecks.length).toBeGreaterThan(0);
    expect(pkg.signature.status).toBe("UNSIGNED"); // §15 honest signature status
    expect(JSON.stringify(pkg)).not.toContain("%PDF");
  });

  t("owner downloads the package; bytes re-parse and hashes match (§21/§52)", async () => {
    const { bytes, sha256 } = await arjun.download(`/api/v1/interoperability/exports/${exportedJobId}/download`);
    expect(arjun.lastStatus).toBe(200);
    expect(bytes).toBeTruthy();
    exportedZip = bytes!;
    expect(sha256).toBe(sha256Hex(bytes!));
    const parsed = parsePackage(bytes!);
    expect(parsed.manifest.package_id).toBe(exportedPackageId);
    // §66 containment: everything in the package belongs to case 1
    expect(parsed.case?.payload.case_id).toBe(case1Ref);
    for (const d of parsed.documents) expect(d.payload.case_id).toBe(case1Ref);
    for (const e of parsed.evidence) expect(e.payload.case_id).toBe(case1Ref);
  });

  t("unrelated officer (different department, not owner) → 403 (§21)", async () => {
    await meera.download(`/api/v1/interoperability/exports/${exportedJobId}/download`);
    expect(meera.lastStatus).toBe(403);
  });

  // §66 document-selection variant runs AFTER the import E2E created
  // doc-bearing cases that arjun cannot access — see the final describe.
  t("§75 — expired package: download denied, file deleted, status EXPIRED", async () => {
    await arjun.req("POST", "/api/v1/interoperability/exports", { caseRef: case1Ref, packageType: "DOCUMENT_EXPORT" });
    expect(arjun.lastStatus).toBe(200);
    const jobId = arjun.lastBody.data.job.jobId;
    const pkgId = arjun.lastBody.data.packageId;
    const jobRow = await db.manualExportJob.findUnique({ where: { jobId } });
    await db.manualExportJob.update({ where: { id: jobRow!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await arjun.download(`/api/v1/interoperability/exports/${jobId}/download`);
    expect(arjun.lastStatus).toBe(410);
    expect(arjun.lastBody.error.code).toBe("PACKAGE_EXPIRED");

    const expired = await db.manualExportJob.findUnique({ where: { jobId } });
    expect(expired!.status).toBe("EXPIRED");
    expect(await db.packageRecord.findUnique({ where: { packageId: pkgId! } })).toBeTruthy(); // metadata retained

    const audit = await db.auditEvent.findFirst({ where: { eventType: "MANUAL_EXPORT_EXPIRED", metadata: { contains: jobId } }, orderBy: { sequence: "desc" } });
    expect(audit).toBeTruthy();
  });
});

// ============================================================
// 4) §77 END-TO-END: import of an external package (CREATE path)
// ============================================================
describe("Phase 9 — import E2E (§77): external package → staging → commit", () => {
  let uploadJobId: string;

  t("external officer uploads a package built by ANOTHER system (§74 identity)", async () => {
    const built = buildPackage(
      makeDraft({
        sourceSystem: SOURCE_LEGACY,
        externalCaseId: "CASE-EXT-911",
        caseTitle: "External robbery case (legacy import)",
        docs: [
          { id: "EXT-DOC-1", seed: "ext-doc-1-bytes", title: "Legacy FIR" },
          { id: "EXT-DOC-2", seed: "ext-doc-2-bytes", title: "Legacy seizure memo" },
        ],
        evidence: [{ id: "EXT-EVD-1", title: "Recovered mobile phone", custodyTrail: true }],
        relationships: [
          { id: "EXT-REL-1", sourceId: "EXT-DOC-1", targetId: "EXT-DOC-2", type: "RELATED", provenance: "AUTHORITATIVE_IMPORT" },
          { id: "EXT-REL-2", sourceId: "EXT-DOC-2", targetId: "EXT-DOC-1", type: "REFERENCE", provenance: "IMPORTED_REFERENCE" },
        ],
      })
    );
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "legacy-case.zip", "Legacy system migration");
    expect(meera.lastStatus).toBe(200);
    uploadJobId = meera.lastBody.data.jobId;
    expect(meera.lastBody.data.status).toBe("UPLOADED");
    // §74 — identity is session-derived; no client field can forge it
    expect(meera.lastBody.data.uploadedByOfficerId).toBeTruthy();
    const job = await db.manualImportJob.findUnique({ where: { jobId: uploadJobId } });
    const meeraOfficer = await db.officer.findFirst({ where: { email: "meera.desai@demo.gov.in" } });
    expect(job!.uploadedByOfficerId).toBe(meeraOfficer!.id);
  });

  t("validate: archive security → schema → integrity → scan → staging (§23)", async () => {
    await meera.req("POST", `/api/v1/interoperability/imports/${uploadJobId}/validate`);
    expect(meera.lastStatus).toBe(200);
    const job = meera.lastBody.data;
    expect(job.status).toBe("STAGED");
    expect(job.integrityResult).toBe("MATCH");
    expect(job.scanStatus).toBe("CLEAN");
    expect(job.schemaVersion).toBe("1.0");
    expect(job.sourceSystem).toBe(SOURCE_LEGACY);
    expect(job.recordsReceived).toBe(6); // 1 case + 2 docs + 1 evidence + 2 relationships
    expect(job.recordsInvalid).toBe(0);
  });

  t("staged records resolve: case/docs/evidence CREATE, reference resolution (§30)", async () => {
    await meera.req("GET", `/api/v1/interoperability/imports/${uploadJobId}`);
    expect(meera.lastStatus).toBe(200);
    const detail = meera.lastBody.data;
    const caseRecord = detail.records.find((r: { recordType: string }) => r.recordType === "CASE");
    expect(caseRecord.resolution).toBe("CREATE");
    const docRecords = detail.records.filter((r: { recordType: string }) => r.recordType === "DOCUMENT");
    expect(docRecords.every((r: { resolution: string }) => r.resolution === "CREATE")).toBe(true);
    // package inspector (§58) — identity without payload exposure
    expect(detail.package.sourceSystem).toBe(SOURCE_LEGACY);
    expect(detail.package.packageSha256).toHaveLength(64);
    expect(JSON.stringify(detail)).not.toContain("%PDF");
  });

  t("commit: Phase 3 documents + Phase 4 evidence + Phase 8 provenance (§31/§32/§42)", async () => {
    await meera.req("POST", `/api/v1/interoperability/imports/${uploadJobId}/commit`);
    expect(meera.lastStatus).toBe(200);
    const result = meera.lastBody.data;
    expect(result.job.status).toBe("COMPLETED");
    expect(result.counters.imported).toBe(5); // case + 2 docs + evidence + AUTHORITATIVE relationship
    expect(result.counters.skipped).toBe(1); // IMPORTED_REFERENCE recorded only (§35)
    expect(result.counters.rejected).toBe(0);
    importedCentralCaseRef = result.job.records?.targetEntityId ?? null;

    const job = await db.manualImportJob.findUnique({ where: { jobId: uploadJobId } });
    const caseRecord = await db.manualImportRecord.findFirst({ where: { importJobId: job!.id, recordType: "CASE" } });
    importedCentralCaseRef = caseRecord!.targetEntityId!;
    expect(importedCentralCaseRef).toMatch(/^CASE-MP-IND-\d{4}-\d{6}$/);
    expect(importedCentralCaseRef).not.toBe("CASE-EXT-911"); // §31: external ID never becomes the central ID

    // ExternalCaseReference preserves the external identity (§31/§42/§61)
    const extRef = await db.externalCaseReference.findFirst({ where: { externalCaseId: "CASE-EXT-911", providerType: "MANUAL_PACKAGE" } });
    expect(extRef).toBeTruthy();
    expect(extRef!.externalSystem).toBe(SOURCE_LEGACY);
    expect(extRef!.importJobId).toBe(uploadJobId);

    // documents went through the REAL Phase 3 pipeline and are immutable
    const docRecords = await db.manualImportRecord.findMany({ where: { importJobId: job!.id, recordType: "DOCUMENT" } });
    expect(docRecords.length).toBe(2);
    for (const rec of docRecords) {
      const doc = await db.caseDocument.findUnique({ where: { documentId: rec.targetEntityId! } });
      expect(doc!.status).toBe("COMMITTED");
      expect(doc!.sha256Hash).toBe(rec.binarySha256); // §32: hash verification
      expect(doc!.storageKey).toContain("cases/");
      expect(doc!.metadata).toContain("MANUAL_PACKAGE_IMPORT");
    }

    // provenance: source package + job + officer recorded (§42)
    const docRef = await db.externalDocumentReference.findFirst({ where: { externalDocumentId: "EXT-DOC-1", providerType: "MANUAL_PACKAGE" } });
    expect(docRef).toBeTruthy();
    expect(docRef!.hashVerified).toBe(true);
    expect(docRef!.importJobId).toBe(uploadJobId);
  });

  t("§72 — evidence custody NOT modified by the package's custody claims", async () => {
    const evRecord = await db.manualImportRecord.findFirst({ where: { recordType: "EVIDENCE", externalId: "EXT-EVD-1" } });
    expect(evRecord).toBeTruthy();
    const evidence = await db.evidence.findUnique({ where: { evidenceId: evRecord!.targetEntityId! } });
    expect(evidence).toBeTruthy();
    // the package CLAIMED custody transferred to "External Forensics" —
    // the platform must register the evidence under the IMPORTING department
    const fsl = await db.department.findFirst({ where: { name: { contains: "Forensic" } } });
    expect(evidence!.currentCustodianDepartmentId).toBe(fsl!.id);
    // and NO custody transfer rows may be created from package data
    const transfers = await db.evidenceTransfer.count({ where: { evidenceId: evidence!.id } });
    expect(transfers).toBe(0);
    expect(evidence!.notes).toContain("custody remains authoritative");
  });

  t("§62/§63 — Phase 5 AI enqueued; Phase 6 graph received the authoritative relationship", async () => {
    const docRef = await db.externalDocumentReference.findFirst({ where: { externalDocumentId: "EXT-DOC-1", providerType: "MANUAL_PACKAGE" } });
    const aiJobs = await db.aIProcessingJob.count({ where: { documentId: docRef!.documentInternalId } });
    expect(aiJobs).toBeGreaterThan(0);

    // graph: AUTHORITATIVE_IMPORT doc→doc edge exists; IMPORTED_REFERENCE does not
    await meera.req("GET", `/api/v1/graph/cases/${importedCentralCaseRef}`);
    expect(meera.lastStatus).toBe(200);
    const edges = meera.lastBody.data.graph.edges as { edgeType: string; relationshipType: string | null; provenance: string }[];
    const humanEdges = edges.filter((e) => e.edgeType === "RELATED" || e.relationshipType === "RELATED");
    expect(humanEdges.length).toBe(1); // only the AUTHORITATIVE_IMPORT pair (REFERENCE provenance is not a graph fact)
  });

  t("§70 — re-uploading the identical package is refused as a duplicate", async () => {
    const built = buildPackage(
      makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-911-DUP", docs: [{ id: "EXT-DUP-DOC", seed: "dup-bytes" }] })
    );
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "dup.zip");
    expect(meera.lastStatus).toBe(200);
    const jobId = meera.lastBody.data.jobId;
    // first copy: validate → creates the PackageRecord (hash registered, §43)
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    expect(meera.lastStatus).toBe(200);
    // re-upload the SAME bytes → duplicate detection
    const jobRow = await db.manualImportJob.findUnique({ where: { jobId } });
    const stored = await (await import("@/lib/documents/storage")).DocumentStorage.get_object(jobRow!.packageStorageKey!);
    const { decryptDocument } = await import("@/lib/documents/encryption");
    const sameBytes = decryptDocument(stored);
    await meera.uploadPackage("/api/v1/interoperability/imports", sameBytes, "same.zip");
    expect(meera.lastStatus).toBe(200);
    const dupJobId = meera.lastBody.data.jobId;
    const dupJob = await db.manualImportJob.findUnique({ where: { jobId: dupJobId } });
    expect(dupJob!.status).toBe("FAILED");
    expect(dupJob!.errorCode).toBe("DUPLICATE_PACKAGE");
    const audit = await db.auditEvent.findFirst({ where: { eventType: "MANUAL_IMPORT_DUPLICATE", metadata: { contains: dupJobId } } });
    expect(audit).toBeTruthy();
  });
});

// ============================================================
// 5) Security tests §67-§69/§71/§73/§76
// ============================================================
describe("Phase 9 — security tests", () => {
  t("§67 — tampered package is BLOCKED at validation", async () => {
    const built = buildPackage(
      makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-TAMPER", docs: [{ id: "TAMPER-DOC-1", seed: "tamper-target-bytes" }] })
    );
    const tampered = tamperBinary(built.zip, pdfBytes("tamper-target-bytes"));
    await meera.uploadPackage("/api/v1/interoperability/imports", tampered, "tampered.zip");
    expect(meera.lastStatus).toBe(200);
    const jobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("PACKAGE_TAMPERED");
    const job = await db.manualImportJob.findUnique({ where: { jobId } });
    expect(job!.status).toBe("FAILED");
    expect(job!.errorCode).toBe("PACKAGE_TAMPERED");
    const audit = await db.auditEvent.findFirst({ where: { eventType: "MANUAL_IMPORT_VALIDATION_FAILED", metadata: { contains: "PACKAGE_TAMPERED" } }, orderBy: { sequence: "desc" } });
    expect(audit).toBeTruthy();
  });

  t("§68 — zip-slip archive is rejected; nothing escapes extraction", async () => {
    const evil = craftZipWithEntry("../../evil-phase9.txt", Buffer.from("pwned"));
    await meera.uploadPackage("/api/v1/interoperability/imports", evil, "evil.zip");
    const jobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("ZIP_PATH_TRAVERSAL");
    // prove nothing escaped into the project/upload roots
    const { access } = await import("fs/promises");
    let escaped = false;
    try {
      await access(join(process.cwd(), "evil-phase9.txt"));
      escaped = true;
    } catch {}
    try {
      await access(join(tmpdir(), "evil-phase9.txt"));
      escaped = true;
    } catch {}
    expect(escaped).toBe(false);
  });

  t("§69 — archive bomb is rejected before resource exhaustion", async () => {
    const bomb = craftZipWithEntry("bomb.bin", Buffer.alloc(32, 0));
    const cdIdx = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(0xffffff00, cdIdx + 24); // declare ~4GB uncompressed
    await meera.uploadPackage("/api/v1/interoperability/imports", bomb, "bomb.zip");
    const jobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("ARCHIVE_BOMB_FILE");
  });

  t("§76 — malicious executable disguised as a document is rejected", async () => {
    const draft = makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-MAL", docs: [] });
    const mzBinary = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(120, 0x41)]);
    const payload: DocumentPayload = {
      document_id: "MAL-DOC-1",
      case_id: "CASE-EXT-MAL",
      title: "Report",
      document_type: "FIR",
      classification: "INTERNAL",
      original_filename: "report.pdf", // innocent name — content decides (§76)
      mime_type: "application/pdf",
      size: mzBinary.length,
      sha256: sha256Hex(mzBinary),
      has_binary: true,
      binary_path: null,
    };
    const built = buildPackage({ ...draft, documents: [{ payload, binary: mzBinary }], manifest: { ...draft.manifest, document_count: 1 } });
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "mal.zip");
    const jobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("MALICIOUS_CONTENT");
    const job = await db.manualImportJob.findUnique({ where: { jobId } });
    expect(job!.scanStatus).toBe("MALICIOUS");
  });
});

// ============================================================
// 6) §71/§73/§37/§40 — immutable documents, downgrade protection,
//    conflict resolution, separation of duties, PARTIAL honesty
// ============================================================
describe("Phase 9 — conflicts, approval, immutability", () => {
  let baseJobId: string; // job that imported EXT-DOC-2 originally
  let conflictJobId: string;

  t("setup: import a case with one RESTRICTED document", async () => {
    const built = buildPackage(
      makeDraft({
        sourceSystem: SOURCE_LEGACY,
        externalCaseId: "CASE-EXT-CONF",
        docs: [{ id: "EXT-CONF-DOC-2", seed: "conf-doc-2-bytes", classification: "RESTRICTED", title: "Original RESTRICTED doc" }],
      })
    );
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "conf.zip");
    baseJobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${baseJobId}/validate`);
    expect(meera.lastStatus).toBe(200);
    await meera.req("POST", `/api/v1/interoperability/imports/${baseJobId}/commit`);
    expect(meera.lastStatus).toBe(200);
    expect(meera.lastBody.data.job.status).toBe("COMPLETED");
  });

  t("§71/§73 — package claiming different bytes + lower classification → CONFLICTS, not overwrite", async () => {
    const built = buildPackage(
      makeDraft({
        sourceSystem: SOURCE_LEGACY,
        externalCaseId: "CASE-EXT-CONF",
        docs: [{ id: "EXT-CONF-DOC-2", seed: "DIFFERENT-BYTES", classification: "INTERNAL", title: "Downgraded replacement attempt" }],
      })
    );
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "conflict.zip");
    conflictJobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${conflictJobId}/validate`);
    expect(meera.lastStatus).toBe(200);
    const job = meera.lastBody.data;
    expect(job.status).toBe("REVIEW_REQUIRED");
    expect(job.recordsConflicted).toBeGreaterThanOrEqual(2);
    const conflicts = job.conflicts ?? [];
    // fetch conflicts via API
    await meera.req("GET", `/api/v1/interoperability/conflicts?jobId=${conflictJobId}`);
    const rows = meera.lastBody.data as { conflictId: string; fieldName: string; conflictType: string; centralValue: string; incomingValue: string; status: string }[];
    const hashConflict = rows.find((c) => c.conflictType === "IMMUTABLE_FIELD" && c.fieldName === "document_sha256");
    const classConflict = rows.find((c) => c.conflictType === "CLASSIFICATION_POLICY" && c.fieldName === "classification");
    expect(hashConflict).toBeTruthy();
    expect(classConflict).toBeTruthy();
    expect(hashConflict!.centralValue).toHaveLength(64);
    void conflicts;
    void baseJobId;
    globalThis.__conflictRows = { hashConflict, classConflict };
  });

  t("§38 — immutable-field conflict cannot be resolved with ACCEPT_INCOMING", async () => {
    const { hashConflict } = globalThis.__conflictRows as { hashConflict: { conflictId: string } };
    await meera.req("POST", `/api/v1/interoperability/conflicts/${hashConflict.conflictId}/resolve`, { resolution: "ACCEPT_INCOMING" });
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("IMMUTABLE_FIELD_PROTECTED");
  });

  t("§73 — classification downgrade via ACCEPT_INCOMING is policy-rejected", async () => {
    const { classConflict } = globalThis.__conflictRows as { classConflict: { conflictId: string } };
    await meera.req("POST", `/api/v1/interoperability/conflicts/${classConflict.conflictId}/resolve`, { resolution: "ACCEPT_INCOMING" });
    expect(meera.lastStatus).toBe(422);
    expect(meera.lastBody.error.code).toBe("CLASSIFICATION_DOWNGRADE_REJECTED");
  });

  t("§37 — reviewer resolves conflicts (KEEP_CENTRAL / REJECT_RECORD) with UI data", async () => {
    const { hashConflict, classConflict } = globalThis.__conflictRows as { hashConflict: { conflictId: string }; classConflict: { conflictId: string } };
    await sysadmin.req("GET", `/api/v1/interoperability/conflicts/${hashConflict.conflictId}`);
    expect(sysadmin.lastStatus).toBe(200);
    expect(sysadmin.lastBody.data.centralValue).toBeTruthy();
    expect(sysadmin.lastBody.data.incomingValue).toBeTruthy();

    await meera.req("POST", `/api/v1/interoperability/conflicts/${hashConflict.conflictId}/resolve`, { resolution: "KEEP_CENTRAL", note: "Central document stays authoritative" });
    expect(meera.lastStatus).toBe(200);
    await meera.req("POST", `/api/v1/interoperability/conflicts/${classConflict.conflictId}/resolve`, { resolution: "REJECT_RECORD", note: "Downgraded replacement refused" });
    expect(meera.lastStatus).toBe(200);
  });

  t("§71 — after resolution, the central document is byte-identical (no overwrite)", async () => {
    const originalRef = await db.externalDocumentReference.findFirst({ where: { externalDocumentId: "EXT-CONF-DOC-2", providerType: "MANUAL_PACKAGE" } });
    const before = await db.caseDocument.findUnique({ where: { id: originalRef!.documentInternalId } });
    expect(before!.sha256Hash).toBe(sha256Hex(pdfBytes("conf-doc-2-bytes")));
    expect(before!.classification).toBe("RESTRICTED");
  });

  t("§40 — separation of duties: the uploader cannot approve their own import", async () => {
    // force a fresh REVIEW_REQUIRED job by rejecting it at approval time —
    // use the conflicted job: conflicts are resolved; approval now possible
    await meera.req("POST", `/api/v1/interoperability/imports/${conflictJobId}/approve`, { comment: "self-approval attempt" });
    expect(meera.lastStatus).toBe(403);
    expect(meera.lastBody.error.code).toBe("SEPARATION_OF_DUTIES");
  });

  t("approval by a second officer → PARTIALLY_APPROVED (rejected record) → honest PARTIAL commit", async () => {
    await sysadmin.req("POST", `/api/v1/interoperability/imports/${conflictJobId}/approve`, { comment: "Approved with rejected replacement" });
    expect(sysadmin.lastStatus).toBe(200);
    expect(["APPROVED", "PARTIALLY_APPROVED"]).toContain(sysadmin.lastBody.data.status);
    await meera.req("POST", `/api/v1/interoperability/imports/${conflictJobId}/commit`);
    expect(meera.lastStatus).toBe(200);
    expect(meera.lastBody.data.job.status).toBe("PARTIAL"); // 1 LINKED + 1 REJECTED record
    expect(meera.lastBody.data.counters.rejected).toBe(1);
    // §45: PARTIAL is reported honestly
    expect(meera.lastBody.data.job.status).not.toBe("COMPLETED");
  });

  t("§45 — a genuinely clean import reports COMPLETED (never PARTIAL)", async () => {
    const built = buildPackage(
      makeDraft({ sourceSystem: SOURCE_LEGACY, externalCaseId: "CASE-EXT-CLEAN", docs: [{ id: "CLEAN-DOC-1", seed: "clean-doc-1" }] })
    );
    await meera.uploadPackage("/api/v1/interoperability/imports", built.zip, "clean.zip");
    const jobId = meera.lastBody.data.jobId;
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/validate`);
    await meera.req("POST", `/api/v1/interoperability/imports/${jobId}/commit`);
    expect(meera.lastBody.data.job.status).toBe("COMPLETED");
  });
});

// ============================================================
// 7) Audit chain + meta + maintenance
// ============================================================
describe("Phase 9 — audit chain, meta, maintenance", () => {
  t("all MANUAL_* events live in the Phase 4 immutable chain and the chain is VALID", async () => {
    const events = await db.auditEvent.findMany({ where: { eventType: { startsWith: "MANUAL_" } }, select: { eventType: true } });
    const kinds = new Set(events.map((e) => e.eventType));
    for (const expected of ["MANUAL_EXPORT_REQUESTED", "MANUAL_EXPORT_COMPLETED", "MANUAL_EXPORT_DOWNLOADED", "MANUAL_EXPORT_EXPIRED", "MANUAL_IMPORT_UPLOADED", "MANUAL_IMPORT_STAGED", "MANUAL_IMPORT_COMPLETED", "MANUAL_IMPORT_DUPLICATE", "MANUAL_IMPORT_CONFLICT_CREATED", "MANUAL_IMPORT_CONFLICT_RESOLVED", "MANUAL_IMPORT_VALIDATION_FAILED"]) {
      expect(kinds.has(expected)).toBe(true);
    }
    const chain = await verifyChain();
    expect(chain.valid).toBe(true);
  });

  t("audit metadata never contains package contents or secrets (§22/§50)", async () => {
    const events = await db.auditEvent.findMany({ where: { eventType: { startsWith: "MANUAL_" } }, take: 200 });
    for (const e of events) {
      expect(e.metadata ?? "").not.toContain("%PDF");
      expect(e.metadata ?? "").not.toContain("BEGIN");
      expect(e.metadata ?? "").not.toMatch(/password/i);
    }
  });

  t("meta route exposes the Phase 9 registries", async () => {
    await arjun.req("GET", "/api/v1/meta");
    expect(arjun.lastStatus).toBe(200);
    expect(Array.isArray(arjun.lastBody.data.interopPackageTypes)).toBe(true);
    expect(arjun.lastBody.data.interopPackageTypes).toContain("FULL_CASE_EXPORT");
    expect(Array.isArray(arjun.lastBody.data.interopAuditEventTypes)).toBe(true);
  });

  t("cleanup endpoint is SYSTEM_ADMIN-only and reports honestly", async () => {
    await arjun.req("POST", "/api/v1/interoperability/maintenance/cleanup");
    expect(arjun.lastStatus).toBe(403);
    await sysadmin.req("POST", "/api/v1/interoperability/maintenance/cleanup");
    expect(sysadmin.lastStatus).toBe(200);
    expect(typeof sysadmin.lastBody.data.expired).toBe("number");
  });

  t("§61 — packages reuse the Phase 8 external-reference provenance layer", async () => {
    const refs = await db.externalCaseReference.count({ where: { providerType: "MANUAL_PACKAGE" } });
    expect(refs).toBeGreaterThanOrEqual(3);
    const docRefs = await db.externalDocumentReference.count({ where: { providerType: "MANUAL_PACKAGE" } });
    expect(docRefs).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// 8) §66 — cross-case SELECTION denial (runs after the import E2E,
//    because the seed's only doc-bearing cases are accessible to
//    arjun; the import E2E creates doc-bearing FSL-custodian cases)
// ============================================================
describe("Phase 9 — §66 cross-case selection denial (post-import)", () => {
  t("selecting a document from an inaccessible case fails WITHOUT leaking it", async () => {
    const police = await db.department.findFirst({ where: { name: { contains: "Police" } } });
    const foreignCase = (await db.case.findMany({ include: { departments: true, documents: true } })).find(
      (c) => c.currentCustodianDepartmentId !== police!.id && !c.departments.some((d) => d.departmentId === police!.id) && c.documents.length > 0
    );
    expect(foreignCase).toBeTruthy();
    const foreign = foreignCase!.documents[0];
    await arjun.req("POST", "/api/v1/interoperability/exports", {
      caseRef: case1Ref,
      packageType: "CASE_EXPORT",
      documentIds: [foreign.documentId],
    });
    expect(arjun.lastStatus).toBe(422);
    expect(arjun.lastBody.error.code).toBe("EXPORT_SELECTION_UNAUTHORIZED");
    expect(JSON.stringify(arjun.lastBody)).not.toContain(foreign.documentId);
  });
});
