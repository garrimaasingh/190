import { DOCUMENT_CLASSIFICATION_LEVEL } from "@/lib/constants";

// ============================================================
// Phase 9 — Manual Import/Export + Interoperability Fallback.
// Registries and hard limits. MANUAL packages are the fallback
// interoperability channel — they are NEVER a live system
// integration, and every UI surface says so.
// ============================================================

/** Supported package schema versions. Importer refuses anything else (§3). */
export const INTEROP_SCHEMA_VERSIONS = ["1.0"] as const;
export type InteropSchemaVersion = (typeof INTEROP_SCHEMA_VERSIONS)[number];
export const INTEROP_SCHEMA_VERSION: InteropSchemaVersion = "1.0";

/** Package types (§4). */
export const PACKAGE_TYPES = [
  "CASE_EXPORT",
  "CASE_IMPORT",
  "DOCUMENT_EXPORT",
  "DOCUMENT_IMPORT",
  "EVIDENCE_EXPORT",
  "EVIDENCE_IMPORT",
  "FULL_CASE_EXPORT",
  "FULL_CASE_IMPORT",
] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const EXPORT_JOB_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] as const;
export const IMPORT_JOB_STATUSES = [
  "UPLOADED",
  "VALIDATING",
  "STAGED",
  "REVIEW_REQUIRED",
  "APPROVED",
  "IMPORTING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "REJECTED",
  "CANCELLED",
] as const;

export const IMPORT_CONFLICT_STATUSES = ["OPEN", "ACCEPT_INCOMING", "KEEP_CENTRAL", "MERGE", "REJECT_RECORD"] as const;
export const IMPORT_APPROVAL_DECISIONS = ["APPROVED", "REJECTED", "PARTIALLY_APPROVED"] as const;
export const IMPORT_RESOLUTIONS = ["CREATE", "LINK_EXISTING", "UPDATE_ALLOWED_FIELD", "CONFLICT", "REJECT"] as const;
export const IMPORT_RECORD_TYPES = ["CASE", "DOCUMENT", "EVIDENCE", "RELATIONSHIP"] as const;

/** Provenance vocabulary for imported relationships (§35). */
export const INTEROP_RELATIONSHIP_PROVENANCE = ["AUTHORITATIVE_IMPORT", "IMPORTED_REFERENCE"] as const;

/** Package classifications (§48) — reuse the document classification ladder. */
export const PACKAGE_CLASSIFICATIONS = ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"] as const;
export type PackageClassification = (typeof PACKAGE_CLASSIFICATIONS)[number];

/** Audit event vocabulary (§22/§51) — all flow through the Phase 4 chain. */
export const INTEROP_AUDIT_EVENT_TYPES = [
  "MANUAL_EXPORT_REQUESTED",
  "MANUAL_EXPORT_STARTED",
  "MANUAL_EXPORT_COMPLETED",
  "MANUAL_EXPORT_FAILED",
  "MANUAL_EXPORT_CANCELLED",
  "MANUAL_EXPORT_DOWNLOADED",
  "MANUAL_EXPORT_EXPIRED",
  "MANUAL_IMPORT_UPLOADED",
  "MANUAL_IMPORT_VALIDATION_STARTED",
  "MANUAL_IMPORT_VALIDATION_FAILED",
  "MANUAL_IMPORT_STAGED",
  "MANUAL_IMPORT_REVIEWED",
  "MANUAL_IMPORT_APPROVED",
  "MANUAL_IMPORT_REJECTED",
  "MANUAL_IMPORT_COMPLETED",
  "MANUAL_IMPORT_PARTIAL",
  "MANUAL_IMPORT_FAILED",
  "MANUAL_IMPORT_DUPLICATE",
  "MANUAL_IMPORT_CONFLICT_CREATED",
  "MANUAL_IMPORT_CONFLICT_RESOLVED",
] as const;

// ------------------------------------------------------------
// Hard limits (§25/§27/§78) — enforced BEFORE any extraction
// using values declared in the archive's central directory, so
// archive bombs are rejected without inflating a single byte.
// ------------------------------------------------------------
export const INTEROP_LIMITS = {
  MAX_UPLOAD_BYTES: 100 * 1024 * 1024, // compressed archive cap (100 MB)
  MAX_UNCOMPRESSED_BYTES: 500 * 1024 * 1024, // total declared uncompressed cap (500 MB)
  MAX_FILE_BYTES: 50 * 1024 * 1024, // per-entry declared cap (50 MB)
  MAX_FILES: 500,
  MAX_COMPRESSION_RATIO: 200, // declaredUncompressed / compressed per archive
  MAX_NESTING_DEPTH: 3, // path directory depth
  MAX_EXPORT_DOCUMENTS: 100,
  MAX_EXPORT_EVIDENCE: 100,
} as const;

/** Export package lifetime (§53). */
export const INTEROP_PACKAGE_TTL_HOURS = Number(process.env.INTEROP_PACKAGE_TTL_HOURS || 24);

/**
 * Import approval policy (§39/§40):
 *  REQUIRED        — jobs with conflicts or HIGHLY_RESTRICTED packages need approval
 *  ALWAYS_REQUIRED — every job needs explicit approval
 * Separation of duties (uploader can never approve) is configurable via
 * INTEROP_SEPARATION_OF_DUTIES and defaults to enforced.
 */
export const INTEROP_IMPORT_APPROVAL_POLICY = (process.env.INTEROP_IMPORT_APPROVAL_POLICY || "REQUIRED") as
  | "REQUIRED"
  | "ALWAYS_REQUIRED";
export const INTEROP_SEPARATION_OF_DUTIES = (process.env.INTEROP_SEPARATION_OF_DUTIES || "true") !== "false";

/** Immutable fields (§38) — an import may never change these once established. */
export const INTEROP_IMMUTABLE_FIELDS = [
  "document_sha256",
  "document_binary",
  "document_committed_at",
  "document_id",
  "evidence_id",
  "case_id",
  "audit_event",
  "custody_event",
] as const;

/** Fields an approved conflict resolution may actually update on a central case (§37). */
export const INTEROP_CASE_MUTABLE_FIELDS = ["title", "description"] as const;

export function classificationLevel(value: string): number {
  return DOCUMENT_CLASSIFICATION_LEVEL[value] ?? 0;
}

/** Most restrictive of the given classifications (§48 — never downgrade). */
export function maxClassification(values: string[]): string {
  return values.reduce(
    (acc, v) => (classificationLevel(v) > classificationLevel(acc) ? v : acc),
    "INTERNAL"
  );
}

export const INTEROP_RATE_LIMITS = {
  EXPORT: { limit: 10, windowMs: 5 * 60 * 1000 },
  IMPORT: { limit: 10, windowMs: 5 * 60 * 1000 },
  DOWNLOAD: { limit: 20, windowMs: 5 * 60 * 1000 },
  DECIDE: { limit: 30, windowMs: 5 * 60 * 1000 },
} as const;
