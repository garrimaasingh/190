import { createHash } from "crypto";
import { z } from "zod";
import { INTEROP_SCHEMA_VERSIONS } from "./constants";
import { buildZip, readZipSecure, sha256Hex, ZipFormatError, type ZipEntry } from "./zip";

// ============================================================
// Phase 9 — versioned interoperability package format (§2-§15).
//
//   manifest.json        identity + counts (§4)
//   metadata.json        purpose/provenance/classification (§7)
//   integrity.json       per-file SHA-256 manifest (§13)
//   case/case.json       case payload (§8)
//   documents/<id>/…     metadata + UNCHANGED binary (§9)
//   evidence/<id>/…      metadata (+binary when digital) (§10/§11)
//   relationships/…      selected relationships (§35)
//   audit/audit-events.json  optional derived audit records (§12)
//
// The canonical package integrity value is SHA-256 over a
// deterministic serialization of the integrity manifest (§14) —
// never over an arbitrarily serialized object. A hash proves
// integrity, NOT authorship — signatures are a separate
// pluggable concern (§15).
// ============================================================

export { ZipFormatError };
export const PACKAGE_INTEGRITY_ALGORITHM = "SHA-256";

// ---------- canonical serialization (§14) ----------

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

// ---------- payload schemas (import side = Zod-validated) ----------

export const manifestSchema = z.object({
  package_id: z.string().regex(/^PKG-MP-IND-\d{4}-\d{6}$/),
  package_type: z.enum([
    "CASE_EXPORT", "CASE_IMPORT", "DOCUMENT_EXPORT", "DOCUMENT_IMPORT",
    "EVIDENCE_EXPORT", "EVIDENCE_IMPORT", "FULL_CASE_EXPORT", "FULL_CASE_IMPORT",
  ]),
  schema_version: z.string(),
  created_at: z.string(),
  created_by: z.string().min(2).max(120),
  source_system: z.string().min(2).max(120),
  source_department: z.string().max(160).optional().nullable(),
  source_application: z.string().max(160).optional().nullable(),
  source_version: z.string().max(60).optional().nullable(),
  source_environment: z.string().max(60).optional().nullable(),
  case_count: z.number().int().nonnegative(),
  document_count: z.number().int().nonnegative(),
  evidence_count: z.number().int().nonnegative(),
  relationship_count: z.number().int().nonnegative(),
  package_size: z.number().int().nonnegative(),
  integrity_algorithm: z.literal("SHA-256"),
  integrity_manifest_reference: z.literal("integrity.json"),
});
export type PackageManifest = z.infer<typeof manifestSchema>;

export const packageMetadataSchema = z.object({
  case_reference: z.string().max(60).optional().nullable(),
  export_purpose: z.string().max(500).optional().nullable(),
  target_system: z.string().max(160).optional().nullable(),
  export_officer: z.string().max(120).optional().nullable(),
  export_department: z.string().max(160).optional().nullable(),
  created_at: z.string().optional().nullable(),
  schema_version: z.string().optional().nullable(),
  classification: z.string().max(40).optional().nullable(),
  record_counts: z
    .object({
      cases: z.number().int().nonnegative().optional(),
      documents: z.number().int().nonnegative().optional(),
      evidence: z.number().int().nonnegative().optional(),
      relationships: z.number().int().nonnegative().optional(),
      audit_events: z.number().int().nonnegative().optional(),
    })
    .optional()
    .nullable(),
});
export type PackageMetadata = z.infer<typeof packageMetadataSchema>;

export const integrityFileSchema = z.object({ path: z.string(), sha256: z.string().length(64), size: z.number().int().nonnegative() });
export const integrityManifestSchema = z.object({
  algorithm: z.literal("SHA-256"),
  files: z.array(integrityFileSchema).max(500),
});
export type IntegrityManifest = z.infer<typeof integrityManifestSchema>;

export const casePayloadSchema = z.object({
  case_id: z.string().min(4).max(60),
  official_case_number: z.string().max(64).optional().nullable(),
  title: z.string().min(2).max(200),
  description: z.string().max(4000).optional().nullable(),
  case_type: z.string().min(2).max(60),
  case_category: z.string().max(60).optional().nullable(),
  priority: z.string().min(2).max(20),
  status: z.string().min(2).max(40),
  geography: z.object({
    country: z.string().max(80).optional().nullable(),
    state: z.string().max(80).optional().nullable(),
    district: z.string().max(80).optional().nullable(),
    city: z.string().max(80).optional().nullable(),
  }).optional().nullable(),
  originating_department: z.string().max(160).optional().nullable(),
  participating_departments: z.array(z.string().max(160)).max(50).optional().nullable(),
  authorized_case_officers: z.array(z.string().max(120)).max(50).optional().nullable(),
  opened_at: z.string().optional().nullable(),
  created_at: z.string().optional().nullable(),
  external_references: z.array(z.string().max(160)).max(50).optional().nullable(),
});
export type CasePayload = z.infer<typeof casePayloadSchema>;

export const documentPayloadSchema = z.object({
  document_id: z.string().min(4).max(60),
  case_id: z.string().min(4).max(60),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  document_type: z.string().min(2).max(60),
  document_category: z.string().max(60).optional().nullable(),
  classification: z.string().min(2).max(40),
  original_filename: z.string().min(1).max(255),
  mime_type: z.string().min(3).max(120),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  committed_at: z.string().optional().nullable(),
  document_date: z.string().optional().nullable(),
  source_department: z.string().max(160).optional().nullable(),
  uploaded_by: z.string().max(120).optional().nullable(),
  has_binary: z.boolean(),
  binary_path: z.string().optional().nullable(),
});
export type DocumentPayload = z.infer<typeof documentPayloadSchema>;

export const custodyRecordSchema = z.object({
  transfer_id: z.string().max(60).optional().nullable(),
  from_department: z.string().max(160).optional().nullable(),
  to_department: z.string().max(160).optional().nullable(),
  requesting_officer: z.string().max(120).optional().nullable(),
  accepting_officer: z.string().max(120).optional().nullable(),
  timestamp: z.string().optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
  status: z.string().max(40).optional().nullable(),
});
export type CustodyRecord = z.infer<typeof custodyRecordSchema>;

export const evidencePayloadSchema = z.object({
  evidence_id: z.string().min(4).max(60),
  case_id: z.string().min(4).max(60),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  evidence_type: z.string().min(2).max(40),
  category: z.string().max(60).optional().nullable(),
  classification: z.string().min(2).max(40),
  status: z.string().min(2).max(40),
  source_type: z.string().max(40).optional().nullable(),
  collection_location: z.string().max(200).optional().nullable(),
  collected_at: z.string().optional().nullable(),
  custodian_department: z.string().max(160).optional().nullable(),
  custodian_officer: z.string().max(120).optional().nullable(),
  sha256: z.string().length(64).optional().nullable(),
  has_binary: z.boolean(),
  binary_path: z.string().optional().nullable(),
  custody_history_available: z.boolean(),
  custody_trail: z.array(custodyRecordSchema).max(100).optional().nullable(),
  external_references: z.array(z.string().max(160)).max(50).optional().nullable(),
});
export type EvidencePayload = z.infer<typeof evidencePayloadSchema>;

export const relationshipPayloadSchema = z.object({
  relationship_id: z.string().min(2).max(80),
  source_type: z.enum(["DOCUMENT", "EVIDENCE"]),
  source_id: z.string().min(4).max(60),
  target_type: z.enum(["DOCUMENT", "EVIDENCE"]),
  target_id: z.string().min(4).max(60),
  relationship_type: z.string().min(2).max(40),
  provenance: z.enum(["AUTHORITATIVE_IMPORT", "IMPORTED_REFERENCE"]),
  created_by: z.string().max(120).optional().nullable(),
  created_at: z.string().optional().nullable(),
});
export type RelationshipPayload = z.infer<typeof relationshipPayloadSchema>;

export const auditExportRecordSchema = z.object({
  event_id: z.string().max(60),
  event_type: z.string().max(60),
  actor: z.string().max(120).optional().nullable(),
  department: z.string().max(160).optional().nullable(),
  case_id: z.string().max(60).optional().nullable(),
  document_id: z.string().max(60).optional().nullable(),
  evidence_id: z.string().max(60).optional().nullable(),
  timestamp: z.string().optional().nullable(),
  result: z.string().max(40).optional().nullable(),
  event_hash: z.string().length(64).optional().nullable(),
  previous_event_hash: z.string().length(64).optional().nullable(),
  ledger_status: z.string().max(40).optional().nullable(),
});
export type AuditExportRecord = z.infer<typeof auditExportRecordSchema>;

// ---------- package builder ----------

export interface PackageDraft {
  manifest: Omit<PackageManifest, "package_size" | "package_id"> & { package_id?: string };
  metadata: PackageMetadata;
  case?: CasePayload;
  documents: { payload: DocumentPayload; binary?: Buffer }[];
  evidence: { payload: EvidencePayload; binary?: Buffer }[];
  relationships: RelationshipPayload[];
  auditEvents?: AuditExportRecord[];
  extraFiles?: ZipEntry[];
}

function binaryPath(prefix: string, id: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "object.bin";
  return `${prefix}/${id}/${safe}`;
}

/** Build the deterministic ZIP for a draft. Returns archive bytes + integrity facts. */
export function buildPackage(draft: PackageDraft): {
  zip: Buffer;
  integrity: IntegrityManifest;
  integrityCanonicalSha256: string;
  rawArchiveSha256: string;
  files: { path: string; sha256: string; size: number }[];
} {
  const entries: ZipEntry[] = [];

  const push = (path: string, data: Buffer) => entries.push({ path, data });

  // ---- fixed deterministic build order ----
  // 1) assign binary paths FIRST so payload serializations are final.
  for (const doc of draft.documents) {
    doc.payload.has_binary = !!doc.binary;
    if (doc.binary) doc.payload.binary_path = binaryPath("documents", doc.payload.document_id, doc.payload.original_filename);
  }
  for (const ev of draft.evidence) {
    ev.payload.has_binary = !!ev.binary;
    if (ev.binary) ev.payload.binary_path = binaryPath("evidence", ev.payload.evidence_id, `evidence-${ev.payload.evidence_id}.bin`);
  }

  // 2) payload entries (binaries get their own entry under the assigned path).
  if (draft.case) push("case/case.json", Buffer.from(canonicalize(draft.case), "utf8"));
  for (const doc of draft.documents) {
    push(`documents/${doc.payload.document_id}/metadata.json`, Buffer.from(canonicalize(doc.payload), "utf8"));
    if (doc.binary && doc.payload.binary_path) push(doc.payload.binary_path, doc.binary);
  }
  for (const ev of draft.evidence) {
    push(`evidence/${ev.payload.evidence_id}/metadata.json`, Buffer.from(canonicalize(ev.payload), "utf8"));
    if (ev.binary && ev.payload.binary_path) push(ev.payload.binary_path, ev.binary);
  }
  if (draft.relationships.length > 0) {
    push("relationships/relationships.json", Buffer.from(canonicalize({ relationships: draft.relationships }), "utf8"));
  }
  if (draft.auditEvents && draft.auditEvents.length > 0) {
    push("audit/audit-events.json", Buffer.from(canonicalize({ audit_events: draft.auditEvents }), "utf8"));
  }
  push("metadata.json", Buffer.from(canonicalize(draft.metadata), "utf8"));

  // 3) manifest BEFORE integrity.json so the manifest itself is covered
  // by the per-file verification. package_size = uncompressed content
  // size of the packaged files excluding manifest.json/integrity.json
  // (the raw archive hash is reported separately for duplicate detection).
  const contentSize = entries.reduce((sum, e) => sum + e.data.length, 0);
  const manifest: PackageManifest = {
    ...(draft.manifest as Omit<PackageManifest, "package_size" | "package_id"> & { package_id?: string }),
    package_id: draft.manifest.package_id ?? "PKG-MP-IND-0000-000000",
    package_size: contentSize,
  } as PackageManifest;
  push("manifest.json", Buffer.from(canonicalize(manifest), "utf8"));

  // 4) integrity manifest over every entry so far — INCLUDING manifest.json (§13).
  const integrity: IntegrityManifest = {
    algorithm: "SHA-256",
    files: entries
      .map((e) => ({ path: e.path, sha256: sha256Hex(e.data), size: e.data.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  push("integrity.json", Buffer.from(canonicalize(integrity), "utf8"));

  const finalZip = buildZip(entries);
  const integrityCanonicalSha256 = canonicalSha256(integrity);
  return {
    zip: finalZip,
    integrity,
    integrityCanonicalSha256,
    rawArchiveSha256: sha256Hex(finalZip),
    files: integrity.files,
  };
}

// ---------- package parser (import side) ----------

export interface ParsedPackage {
  manifest: PackageManifest;
  metadata: PackageMetadata;
  integrity: IntegrityManifest;
  integrityCanonicalSha256: string;
  rawArchiveSha256: string;
  case?: { payload: CasePayload; raw: Record<string, unknown> };
  documents: { payload: DocumentPayload; binary: Buffer | null }[];
  evidence: { payload: EvidencePayload; binary: Buffer | null }[];
  relationships: RelationshipPayload[];
  auditEvents: AuditExportRecord[];
  entries: ZipEntry[];
}

function parseJsonEntry<T>(entry: ZipEntry | undefined, schema: { parse: (v: unknown) => T }, label: string): T {
  if (!entry) throw new ZipFormatError("PACKAGE_MISSING_FILE", `Package is missing ${label}.`);
  try {
    return schema.parse(JSON.parse(entry.data.toString("utf8")));
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ZipFormatError("PACKAGE_SCHEMA_INVALID", `${label} failed schema validation: ${err.issues[0]?.path.join(".")} ${err.issues[0]?.message}`);
    }
    throw new ZipFormatError("PACKAGE_JSON_INVALID", `${label} is not valid JSON.`);
  }
}

function parseOptionalJsonEntry<T>(entry: ZipEntry | undefined, schema: { parse: (v: unknown) => T }, label: string): T | null {
  if (!entry) return null;
  return parseJsonEntry(entry, schema, label);
}

/**
 * Structural parse + integrity verification (§13/§14). This function:
 *  1. runs the secure ZIP reader (limits, zip-slip, bombs),
 *  2. verifies EVERY file hash against integrity.json,
 *  3. verifies manifest counts vs actual files,
 *  4. verifies declared schema_version is supported.
 * Hash mismatch → PACKAGE_TAMPERED (import blocked, §67).
 */
export function parsePackage(archive: Buffer): ParsedPackage {
  const entries = readZipSecure(archive, {
    maxCompressedBytes: Number(process.env.INTEROP_MAX_UPLOAD_BYTES || 100 * 1024 * 1024),
    maxUncompressedBytes: Number(process.env.INTEROP_MAX_UNCOMPRESSED_BYTES || 500 * 1024 * 1024),
    maxFileBytes: Number(process.env.INTEROP_MAX_FILE_BYTES || 50 * 1024 * 1024),
    maxFiles: 500,
    maxCompressionRatio: 200,
    maxDepth: 3,
  });
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const manifest = parseJsonEntry(byPath.get("manifest.json"), manifestSchema, "manifest.json");
  const metadata = parseOptionalJsonEntry(byPath.get("metadata.json"), packageMetadataSchema, "metadata.json") ?? ({} as PackageMetadata);
  const integrity = parseJsonEntry(byPath.get("integrity.json"), integrityManifestSchema, "integrity.json");

  if (!INTEROP_SCHEMA_VERSIONS.includes(manifest.schema_version as never)) {
    throw new ZipFormatError("PACKAGE_SCHEMA_UNSUPPORTED", `Package schema version ${manifest.schema_version} is not supported (supported: ${INTEROP_SCHEMA_VERSIONS.join(", ")}).`);
  }

  // ---- integrity verification: every declared file must match byte-for-byte ----
  const entryPaths = new Set(entries.filter((e) => e.path !== "integrity.json").map((e) => e.path));
  const declaredPaths = new Set<string>();
  for (const f of integrity.files) {
    declaredPaths.add(f.path);
    const entry = byPath.get(f.path);
    if (!entry) throw new ZipFormatError("PACKAGE_TAMPERED", `Integrity manifest lists a file that is missing: ${f.path}`);
    const actual = sha256Hex(entry.data);
    if (actual !== f.sha256) {
      throw new ZipFormatError("PACKAGE_TAMPERED", `Integrity verification FAILED for ${f.path} — package must not be imported.`);
    }
    if (entry.data.length !== f.size) {
      throw new ZipFormatError("PACKAGE_TAMPERED", `Size mismatch for ${f.path} — package must not be imported.`);
    }
  }
  for (const p of entryPaths) {
    if (!declaredPaths.has(p)) throw new ZipFormatError("PACKAGE_TAMPERED", `File present in package but missing from integrity manifest: ${p}`);
  }

  // ---- manifest count sanity (declared counts vs packaged reality) ----
  const caseCount = byPath.has("case/case.json") ? 1 : 0;
  const documentCount = [...byPath.keys()].filter((p) => /^documents\/[^/]+\/metadata\.json$/.test(p)).length;
  const evidenceCount = [...byPath.keys()].filter((p) => /^evidence\/[^/]+\/metadata\.json$/.test(p)).length;
  const relationshipCount = byPath.has("relationships/relationships.json")
    ? ((JSON.parse(byPath.get("relationships/relationships.json")!.data.toString("utf8")) as { relationships: unknown[] }).relationships || []).length
    : 0;
  if (
    manifest.case_count !== caseCount ||
    manifest.document_count !== documentCount ||
    manifest.evidence_count !== evidenceCount ||
    manifest.relationship_count !== relationshipCount
  ) {
    throw new ZipFormatError("PACKAGE_MANIFEST_MISMATCH", "Manifest record counts do not match the packaged contents.");
  }

  // ---- payloads ----
  const caseEntry = byPath.get("case/case.json");
  const documents: ParsedPackage["documents"] = [];
  for (const [path, entry] of byPath) {
    const m = /^documents\/([^/]+)\/metadata\.json$/.exec(path);
    if (!m) continue;
    const payload = parseJsonEntry(entry, documentPayloadSchema, path);
    if (payload.document_id !== m[1]) throw new ZipFormatError("PACKAGE_SCHEMA_INVALID", `Document metadata id does not match its folder: ${path}`);
    const binary = payload.binary_path ? byPath.get(payload.binary_path) ?? null : null;
    if (payload.has_binary && !binary) throw new ZipFormatError("PACKAGE_MISSING_FILE", `Document ${payload.document_id} declares a binary that is missing.`);
    if (binary && sha256Hex(binary.data) !== payload.sha256) {
      throw new ZipFormatError("PACKAGE_TAMPERED", `Document ${payload.document_id} binary hash does not match its metadata — package must not be imported.`);
    }
    documents.push({ payload, binary: binary?.data ?? null });
  }

  const evidence: ParsedPackage["evidence"] = [];
  for (const [path, entry] of byPath) {
    const m = /^evidence\/([^/]+)\/metadata\.json$/.exec(path);
    if (!m) continue;
    const payload = parseJsonEntry(entry, evidencePayloadSchema, path);
    if (payload.evidence_id !== m[1]) throw new ZipFormatError("PACKAGE_SCHEMA_INVALID", `Evidence metadata id does not match its folder: ${path}`);
    const binary = payload.binary_path ? byPath.get(payload.binary_path) ?? null : null;
    if (payload.has_binary && !binary) throw new ZipFormatError("PACKAGE_MISSING_FILE", `Evidence ${payload.evidence_id} declares a binary that is missing.`);
    if (binary && payload.sha256 && sha256Hex(binary.data) !== payload.sha256) {
      throw new ZipFormatError("PACKAGE_TAMPERED", `Evidence ${payload.evidence_id} binary hash does not match its metadata — package must not be imported.`);
    }
    evidence.push({ payload, binary: binary?.data ?? null });
  }

  const relationships = byPath.has("relationships/relationships.json")
    ? parseJsonEntry(byPath.get("relationships/relationships.json")!, z.object({ relationships: z.array(relationshipPayloadSchema).max(500) }), "relationships/relationships.json").relationships
    : [];

  const auditEvents = byPath.has("audit/audit-events.json")
    ? parseJsonEntry(byPath.get("audit/audit-events.json")!, z.object({ audit_events: z.array(auditExportRecordSchema).max(1000) }), "audit/audit-events.json").audit_events
    : [];

  const casePayload = caseEntry ? parseJsonEntry(caseEntry, casePayloadSchema, "case/case.json") : undefined;

  return {
    manifest,
    metadata,
    integrity,
    integrityCanonicalSha256: canonicalSha256(integrity),
    rawArchiveSha256: sha256Hex(archive),
    case: casePayload ? { payload: casePayload, raw: JSON.parse(caseEntry!.data.toString("utf8")) } : undefined,
    documents,
    evidence,
    relationships,
    auditEvents,
    entries,
  };
}
