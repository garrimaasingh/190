// ============================================================
// Controlled reference data — single source of truth for
// statuses, department types and roles. The frontend never
// hard-codes these; it loads them from GET /api/v1/meta.
// ============================================================

export const COUNTRY_CODE = "IN"; // root geography for the platform

export const DEPARTMENT_TYPES = [
  "POLICE",
  "FORENSICS",
  "PROSECUTION",
  "COURT",
  "PRISON",
  "INVESTIGATION",
  "OTHER",
] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export const DEPARTMENT_TYPE_ABBREV: Record<string, string> = {
  POLICE: "POL",
  FORENSICS: "FSL",
  PROSECUTION: "PRO",
  COURT: "CRT",
  PRISON: "PRS",
  INVESTIGATION: "INV",
  OTHER: "OTH",
};

export const DEPARTMENT_STATUSES = ["ACTIVE", "INACTIVE", "PENDING"] as const;
export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export const OFFICER_ROLES = [
  "SYSTEM_ADMIN",
  "DEPARTMENT_ADMIN",
  "OFFICER",
  "AUDITOR",
] as const;
export type OfficerRole = (typeof OFFICER_ROLES)[number];

export const OFFICER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "INACTIVE"] as const;
export type OfficerStatus = (typeof OFFICER_STATUSES)[number];

// Officer lifecycle transitions (spec §25)
export const OFFICER_STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["SUSPENDED", "INACTIVE"],
  SUSPENDED: ["ACTIVE", "INACTIVE"],
  INACTIVE: ["ACTIVE"],
};

export const ENTITY_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export const GEOGRAPHY_STATUSES = ["ACTIVE", "INACTIVE"] as const;

// Roles a given actor may assign when creating/updating officers
export const ASSIGNABLE_ROLES: Record<string, OfficerRole[]> = {
  SYSTEM_ADMIN: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER", "AUDITOR"],
  DEPARTMENT_ADMIN: ["DEPARTMENT_ADMIN", "OFFICER"],
  OFFICER: [],
  AUDITOR: [],
};

// Officers with these statuses cannot authenticate (spec §25)
export const AUTH_ALLOWED_STATUSES: string[] = ["ACTIVE"];

// Logo constraints (spec §8 / §47)
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const LOGO_ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MIN_DIM = 32;
export const LOGO_MAX_DIM = 4096;

export const PASSWORD_MIN_LENGTH = 8;

export const SESSION_COOKIE = "cp_session";
export const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 8);

export const PAGE_SIZES = { DEFAULT: 10, MAX: 100 };

// ============================================================
// PHASE 2 — Case classification (spec §6/§7).
// Extensible reference lists — business logic must never
// hard-code these values; add new entries here only.
// ============================================================

export const CASE_TYPES = [
  "CRIMINAL",
  "CYBERCRIME",
  "WOMEN_SAFETY",
  "CHILD_RELATED",
  "FINANCIAL",
  "ORGANIZED_CRIME",
  "MISSING_PERSON",
  "FORENSIC",
  "OTHER",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_STATUSES = [
  "DRAFT",
  "OPEN",
  "UNDER_INVESTIGATION",
  "PENDING_FORENSICS",
  "PENDING_PROSECUTION",
  "PENDING_COURT",
  "CLOSED",
  "ARCHIVED",
  "CANCELLED",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

// Controlled lifecycle (spec §8). Not every case traverses every state.
// Terminal states: ARCHIVED, CANCELLED.
export const CASE_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["UNDER_INVESTIGATION", "CANCELLED"],
  UNDER_INVESTIGATION: ["PENDING_FORENSICS", "PENDING_PROSECUTION", "PENDING_COURT", "CLOSED", "CANCELLED"],
  PENDING_FORENSICS: ["UNDER_INVESTIGATION", "PENDING_PROSECUTION", "CANCELLED"],
  PENDING_PROSECUTION: ["PENDING_COURT", "UNDER_INVESTIGATION", "CANCELLED"],
  PENDING_COURT: ["CLOSED", "UNDER_INVESTIGATION", "CANCELLED"],
  CLOSED: ["ARCHIVED"],
  ARCHIVED: [],
  CANCELLED: [],
};

export const CASE_TERMINAL_STATUSES: string[] = ["ARCHIVED", "CANCELLED"];
// Statuses in which case metadata/participants may still be modified
export const CASE_MUTABLE_STATUSES: string[] = [
  "DRAFT",
  "OPEN",
  "UNDER_INVESTIGATION",
  "PENDING_FORENSICS",
  "PENDING_PROSECUTION",
  "PENDING_COURT",
];

// Statuses that imply the case is still operationally live (used for
// transfer eligibility and dashboard summaries).
export const CASE_ACTIVE_LIFECYCLE_STATUSES: string[] = [
  "DRAFT",
  "OPEN",
  "UNDER_INVESTIGATION",
  "PENDING_FORENSICS",
  "PENDING_PROSECUTION",
  "PENDING_COURT",
];

export const PARTICIPATION_TYPES = [
  "ORIGINATING",
  "ACTIVE_CUSTODIAN",
  "PARTICIPATING",
  "CONSULTED",
  "HISTORICAL",
] as const;
export type ParticipationType = (typeof PARTICIPATION_TYPES)[number];

export const CASE_OFFICER_ROLES = [
  "LEAD_INVESTIGATOR",
  "INVESTIGATING_OFFICER",
  "FORENSIC_OFFICER",
  "PROSECUTION_OFFICER",
  "COURT_OFFICER",
  "SUPPORT_OFFICER",
  "REVIEWER",
] as const;
export type CaseOfficerRole = (typeof CASE_OFFICER_ROLES)[number];

export const CASE_OFFICER_STATUSES = ["ACTIVE", "REMOVED"] as const;

export const CASE_DEPARTMENT_STATUSES = ["ACTIVE", "REMOVED"] as const;

export const TRANSFER_STATUSES = ["REQUESTED", "ACCEPTED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

// Case timeline / audit event types (spec §24/§25). Future phases
// extend this registry — no schema redesign required.
export const CASE_EVENT_TYPES = [
  "CASE_CREATED",
  "CASE_UPDATED",
  "CASE_STATUS_CHANGED",
  "CASE_OFFICER_ASSIGNED",
  "CASE_OFFICER_UNASSIGNED",
  "CASE_DEPARTMENT_ADDED",
  "CASE_DEPARTMENT_REMOVED",
  "CASE_TRANSFER_REQUESTED",
  "CASE_TRANSFER_ACCEPTED",
  "CASE_TRANSFER_REJECTED",
  "CASE_TRANSFER_CANCELLED",
  "CASE_ACCESS_DENIED",
  // Phase 3 — documents (spec §51 registry; Phase 4 audit ledger can
  // subscribe to these without schema redesign):
  "DOCUMENT_UPLOAD_STARTED",
  "DOCUMENT_VALIDATION_STARTED",
  "DOCUMENT_VALIDATION_FAILED",
  "DOCUMENT_COMMITTED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_DOWNLOAD_REQUESTED",
  "DOCUMENT_DOWNLOAD_COMPLETED",
  "DOCUMENT_DOWNLOAD_FAILED",
  "DOCUMENT_SUPPLEMENT_CREATED",
  "DOCUMENT_CORRECTION_CREATED",
  "DOCUMENT_REPLACEMENT_CREATED",
  "DOCUMENT_SUPERSEDED",
  "DOCUMENT_RELATIONSHIP_CREATED",
  "DOCUMENT_INTEGRITY_VERIFIED",
  "DOCUMENT_ACCESS_DENIED",
  "EVIDENCE_REGISTERED",
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_CUSTODY_CHANGED",
  "EVIDENCE_UPDATED",
] as const;
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];

export const CASE_NUMBER_MAX_LENGTH = 64;
export const CASE_TITLE_MAX_LENGTH = 200;
export const CASE_DESCRIPTION_MAX_LENGTH = 4000;

// ============================================================
// PHASE 3 — Documents (spec §58 forward refs).
// Reference lists are extensible registries; business logic and
// UI must read them from here / GET /api/v1/meta, never inline.
// ============================================================

// ============================================================
// PHASE 3 — Secure Digital Document Management (spec §5-§9, §51).
//
// IMMUTABILITY PRINCIPLE (spec §2): a COMMITTED document is never
// edited, overwritten or deleted. Corrections/supplements are NEW
// immutable records linked by DocumentRelationship. Status/type
// fields are strings validated at the application boundary (Zod)
// — SQLite has no enums; the schema stays PostgreSQL-portable.
// ============================================================

// Document type registry (spec §6). Extensible — add new entries
// here only; business logic and UI must never hard-code them.
export const DOCUMENT_TYPES = [
  "FIR",
  "CASE_DIARY",
  "WITNESS_STATEMENT",
  "INVESTIGATION_REPORT",
  "FORENSIC_REPORT",
  "CHARGE_SHEET",
  "PROSECUTION_DOCUMENT",
  "COURT_DOCUMENT",
  "COURT_ORDER",
  "JUDGMENT",
  "LEGAL_NOTICE",
  "CORRESPONDENCE",
  "IDENTITY_DOCUMENT",
  "EVIDENCE_REPORT",
  "OTHER",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// Coarse document category (spec §5 document_category) — separate
// from the fine-grained type above.
export const DOCUMENT_CATEGORIES = [
  "CASE_RECORD",
  "INVESTIGATION",
  "FORENSIC",
  "JUDICIAL",
  "PROSECUTION",
  "ADMINISTRATIVE",
  "CORRESPONDENCE",
  "IDENTIFICATION",
  "OTHER",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

// Security classification (spec §7) — independent of document type.
// Classification LEVEL is the ordering used by document-level
// authorization; the ceiling maps define which classification a
// role may ASSIGN at upload (spec §7: ordinary users must not
// arbitrarily assign highly restricted classifications).
export const DOCUMENT_CLASSIFICATIONS = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "HIGHLY_RESTRICTED",
] as const;
export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

export const DOCUMENT_CLASSIFICATION_LEVEL: Record<string, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  HIGHLY_RESTRICTED: 4,
};

// UI explanations (spec §54) — concrete controls, no security theatre.
export const DOCUMENT_CLASSIFICATION_NOTES: Record<string, string> = {
  PUBLIC: "Not sensitive. Visible to platform users with access to the case.",
  INTERNAL: "For internal working documents. Visible to authorized case participants.",
  CONFIDENTIAL: "Sensitive case material. Requires explicit case assignment or custodian authority.",
  RESTRICTED: "Access is limited to authorized case participants with custodian authority.",
  HIGHLY_RESTRICTED: "Highest sensitivity. Requires custodian administrative authority to assign and view.",
};

// Highest classification a role may ASSIGN at upload (spec §7).
// AUDITOR cannot upload at all (permission layer already denies).
export const DOCUMENT_CLASSIFICATION_CEILING: Record<string, number> = {
  SYSTEM_ADMIN: 4,
  DEPARTMENT_ADMIN: 4, // custodian-side department admins only (case manage is also required)
  OFFICER: 3, // RESTRICTED — ordinary officers cannot mint HIGHLY_RESTRICTED
  AUDITOR: -1,
};

// Document status lifecycle (spec §8). A COMMITTED document is
// immutable; SUPERSEDED documents remain stored and visible per
// authorization policy; QUARANTINED records were never valid.
export const DOCUMENT_STATUSES = [
  "UPLOADING",
  "VALIDATING",
  "COMMITTED",
  "QUARANTINED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  UPLOADING: ["VALIDATING"],
  VALIDATING: ["COMMITTED", "QUARANTINED"],
  COMMITTED: ["SUPERSEDED", "ARCHIVED"],
  QUARANTINED: [],
  SUPERSEDED: [],
  ARCHIVED: [],
};

// Document relationship types (spec §9). SUPPLEMENT/CORRECTION/
// REPLACEMENT are created only through their dedicated workflows;
// RELATED/REFERENCE may be linked between existing documents.
export const DOCUMENT_RELATIONSHIP_TYPES = [
  "SUPPLEMENT",
  "CORRECTION",
  "REPLACEMENT",
  "RELATED",
  "REFERENCE",
] as const;
export type DocumentRelationshipType = (typeof DOCUMENT_RELATIONSHIP_TYPES)[number];

// Document event registry (spec §51/§52) — the audit interface
// Phase 4's immutable ledger will consume.
export const DOCUMENT_EVENT_TYPES = [
  "DOCUMENT_UPLOAD_STARTED",
  "DOCUMENT_VALIDATION_STARTED",
  "DOCUMENT_VALIDATION_FAILED",
  "DOCUMENT_COMMITTED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_DOWNLOAD_REQUESTED",
  "DOCUMENT_DOWNLOAD_COMPLETED",
  "DOCUMENT_DOWNLOAD_FAILED",
  "DOCUMENT_SUPPLEMENT_CREATED",
  "DOCUMENT_CORRECTION_CREATED",
  "DOCUMENT_REPLACEMENT_CREATED",
  "DOCUMENT_SUPERSEDED",
  "DOCUMENT_RELATIONSHIP_CREATED",
  "DOCUMENT_INTEGRITY_VERIFIED",
  "DOCUMENT_ACCESS_DENIED",
] as const;
export type DocumentEventType = (typeof DOCUMENT_EVENT_TYPES)[number];

// Upload session states (spec §12/§69) — the two-phase commit
// state model. A document row is created ONLY at commit time, so
// a failed upload can never appear as a valid legal document.
export const UPLOAD_SESSION_STATUSES = [
  "UPLOADING",
  "VALIDATING",
  "STORING",
  "COMMITTING",
  "COMMITTED",
  "FAILED",
  "QUARANTINED",
  "DISCARDED",
] as const;

export const ENCRYPTION_STATUSES = ["ENCRYPTED_AES_256_GCM"] as const;
export const STORAGE_PROVIDERS = ["LOCAL_ENCRYPTED_FS"] as const;

// Upload controls (spec §13/§14): strict whitelist — content type is
// decided by magic-byte detection, never by the client declaration.
// Office/zip formats are intentionally excluded (polyglot risk, weak
// magic); the viewer supports PDF/image/text preview only (spec §47),
// so universal-format claims are never made.
export const DOCUMENT_ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  csv: "text/csv",
};
export const DOCUMENT_ALLOWED_MIME = Array.from(new Set(Object.values(DOCUMENT_ALLOWED_EXTENSIONS)));

export const DOCUMENT_MAX_SIZE_MB = Number(process.env.DOCUMENT_MAX_SIZE_MB || 25);
export const DOCUMENT_MAX_BYTES = DOCUMENT_MAX_SIZE_MB * 1024 * 1024;

export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const DOCUMENT_DESCRIPTION_MAX_LENGTH = 2000;
export const DOCUMENT_REFERENCE_MAX_LENGTH = 100;
export const DOCUMENT_TAG_MAX_LENGTH = 24;
export const DOCUMENT_TAGS_MAX_COUNT = 10;

// Case statuses that allow new document additions (spec §56/§57):
// archived/closed/cancelled cases reject uploads; viewing remains.
export const DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES: string[] = [
  "DRAFT",
  "OPEN",
  "UNDER_INVESTIGATION",
  "PENDING_FORENSICS",
  "PENDING_PROSECUTION",
  "PENDING_COURT",
];

// Encryption key material is NEVER stored alongside documents —
// it comes from the environment (dev) / KMS (production, future).
export const DOCUMENT_KEY_REFERENCE =
  process.env.DOCUMENT_KEY_REFERENCE || "DEV-ENV-KEY-1"; // labeled dev-safe key provider

// ============================================================
// PHASE 3 — Evidence & chain of custody.
// Item status changes ONLY through EvidenceService transitions,
// each of which writes an EvidenceCustodyEvent in the same
// transaction. Extensible registry per platform convention.
// ============================================================

export const EVIDENCE_TYPES = [
  "PHYSICAL",
  "DIGITAL",
  "DOCUMENTARY",
  "BIOLOGICAL",
  "CHEMICAL",
  "NARCOTICS",
  "WEAPON",
  "ELECTRONIC_DEVICE",
  "FINANCIAL",
  "OTHER",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_STATUSES = [
  "REGISTERED",
  "COLLECTED",
  "IN_CUSTODY",
  "SUBMITTED",
  "UNDER_EXAMINATION",
  "EXAMINED",
  "RETURNED",
  "CONSUMED",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// Controlled custody lifecycle. Terminal: RETURNED, CONSUMED.
export const EVIDENCE_STATUS_TRANSITIONS: Record<string, string[]> = {
  REGISTERED: ["COLLECTED", "IN_CUSTODY"],
  COLLECTED: ["IN_CUSTODY", "SUBMITTED", "RETURNED", "CONSUMED"],
  IN_CUSTODY: ["SUBMITTED", "RETURNED", "CONSUMED"],
  SUBMITTED: ["UNDER_EXAMINATION", "IN_CUSTODY", "RETURNED"],
  UNDER_EXAMINATION: ["EXAMINED", "IN_CUSTODY"],
  EXAMINED: ["IN_CUSTODY", "RETURNED", "CONSUMED"],
  RETURNED: [],
  CONSUMED: [],
};

export const EVIDENCE_TERMINAL_STATUSES: string[] = ["RETURNED", "CONSUMED"];

export const EVIDENCE_CUSTODY_ACTIONS = [
  "COLLECTED",
  "STORED",
  "TRANSFERRED",
  "SUBMITTED",
  "RECEIVED",
  "EXAMINED",
  "RETURNED",
  "CONSUMED",
] as const;
export type EvidenceCustodyAction = (typeof EVIDENCE_CUSTODY_ACTIONS)[number];

export const EVIDENCE_TITLE_MAX_LENGTH = 200;
export const EVIDENCE_DESCRIPTION_MAX_LENGTH = 2000;
export const EVIDENCE_LOCATION_MAX_LENGTH = 200;
export const EVIDENCE_NOTES_MAX_LENGTH = 1000;

export const ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  GEOGRAPHY_HIERARCHY_INVALID: "GEOGRAPHY_HIERARCHY_INVALID",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  // Phase 2
  CASE_NOT_FOUND: "CASE_NOT_FOUND",
  CASE_ACCESS_DENIED: "CASE_ACCESS_DENIED",
  CASE_IMMUTABLE: "CASE_IMMUTABLE",
  INVALID_TRANSFER_STATE: "INVALID_TRANSFER_STATE",
  TRANSFER_ALREADY_PENDING: "TRANSFER_ALREADY_PENDING",
  STALE_CUSTODY_STATE: "STALE_CUSTODY_STATE",
  CONCURRENCY_CONFLICT: "CONCURRENCY_CONFLICT",
  DEPARTMENT_INELIGIBLE: "DEPARTMENT_INELIGIBLE",
  OFFICER_INELIGIBLE: "OFFICER_INELIGIBLE",
  // Phase 3
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  DOCUMENT_ACCESS_DENIED: "DOCUMENT_ACCESS_DENIED",
  DOCUMENT_IMMUTABLE: "DOCUMENT_IMMUTABLE",
  INVALID_DOCUMENT_STATE: "INVALID_DOCUMENT_STATE",
  INVALID_RELATIONSHIP: "INVALID_RELATIONSHIP",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  FILE_SCAN_FAILED: "FILE_SCAN_FAILED",
  UPLOAD_DUPLICATE_IN_PROGRESS: "UPLOAD_DUPLICATE_IN_PROGRESS",
  INVALID_FILE: "INVALID_FILE",
  EVIDENCE_NOT_FOUND: "EVIDENCE_NOT_FOUND",
  INVALID_EVIDENCE_TRANSITION: "INVALID_EVIDENCE_TRANSITION",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
