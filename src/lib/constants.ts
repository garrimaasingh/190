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

// Evidence digital content (spec §11) — the EVIDENCE pipeline accepts
// a WIDER format set than documents: CCTV.mp4, phone extraction.zip
// and raw disk images (dd — no magic by definition, stored as opaque
// application/octet-stream with the SHA-256 as the integrity anchor).
// Documents keep the strict Phase 3 whitelist unchanged.
export const EVIDENCE_ALLOWED_EXTENSIONS: Record<string, string> = {
  ...DOCUMENT_ALLOWED_EXTENSIONS,
  mp4: "video/mp4",
  zip: "application/zip",
};

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
// PHASE 4 — Evidence & immutable audit (spec §6/§7/§8/§9/§20-§27).
// Reference registries are extensible by design (spec §6 "keep the
// architecture extensible"); they are SYSTEM CLASSIFICATION values,
// not claims of exhaustive legal categories (spec §7). Source of
// truth for business logic and UI — served via GET /api/v1/meta.
// ============================================================

// Evidence types (spec §6). Extensible — add new entries here only.
export const EVIDENCE_TYPES = [
  "PHYSICAL",
  "DIGITAL",
  "DOCUMENTARY",
  "AUDIO",
  "VIDEO",
  "IMAGE",
  "FORENSIC_SAMPLE",
  "DEVICE",
  "OTHER",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

// Acquisition source types (spec §7). System classification values —
// NOT claimed to be exhaustive legal categories.
export const EVIDENCE_SOURCE_TYPES = [
  "POLICE_SEIZURE",
  "COURT_SUBMISSION",
  "FORENSIC_LAB",
  "DIGITAL_EXTRACTION",
  "CCTV_SYSTEM",
  "WITNESS_SUBMISSION",
  "DEPARTMENT_TRANSFER",
  "EXTERNAL_IMPORT",
  "OTHER",
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

// Evidence lifecycle (spec §8). Transitions are controlled by the
// status service — the frontend can never set arbitrary statuses.
// TRANSFER_PENDING / TRANSFERRED are driven by the custody service;
// TRANSFER_PENDING → TRANSFERRED on accept, restored to the prior
// operational status on reject/cancel.
export const EVIDENCE_STATUSES = [
  "REGISTERED",
  "COLLECTED",
  "IN_CUSTODY",
  "TRANSFER_PENDING",
  "TRANSFERRED",
  "UNDER_EXAMINATION",
  "RETURNED",
  "RELEASED",
  "ARCHIVED",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// Controlled lifecycle (spec §8). Terminal: ARCHIVED (and RELEASED
// → ARCHIVED only). TRANSFER_PENDING is service-managed: accept →
// TRANSFERRED; reject/cancel → previous operational status.
export const EVIDENCE_STATUS_TRANSITIONS: Record<string, string[]> = {
  REGISTERED: ["COLLECTED", "IN_CUSTODY", "UNDER_EXAMINATION", "ARCHIVED"],
  COLLECTED: ["IN_CUSTODY", "UNDER_EXAMINATION", "RETURNED", "ARCHIVED"],
  IN_CUSTODY: ["UNDER_EXAMINATION", "RETURNED", "RELEASED", "ARCHIVED"],
  TRANSFER_PENDING: ["TRANSFERRED", "IN_CUSTODY"], // service-managed only
  TRANSFERRED: ["IN_CUSTODY", "UNDER_EXAMINATION", "RETURNED", "RELEASED", "ARCHIVED"],
  UNDER_EXAMINATION: ["IN_CUSTODY", "RETURNED", "RELEASED", "ARCHIVED"],
  RETURNED: ["RELEASED", "ARCHIVED"],
  RELEASED: ["ARCHIVED"],
  ARCHIVED: [], // terminal
};

export const EVIDENCE_TERMINAL_STATUSES: string[] = ["ARCHIVED"];

// Statuses that accept new documents/evidence on the parent case
// reuse DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES (same operational
// notion: live cases only — archived/closed/cancelled are frozen).

// Evidence access classification (spec §9) — reuses the Phase 3
// LEVEL ordering; PUBLIC is deliberately excluded: evidence is by
// nature case-sensitive material.
export const EVIDENCE_CLASSIFICATIONS = [
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "HIGHLY_RESTRICTED",
] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

export const EVIDENCE_CLASSIFICATION_NOTES: Record<string, string> = {
  INTERNAL: "Working evidence records. Visible to authorized case participants.",
  CONFIDENTIAL: "Sensitive evidence. Requires explicit case assignment or custodian authority.",
  RESTRICTED: "Access limited to authorized participants with custodian authority.",
  HIGHLY_RESTRICTED: "Highest sensitivity. Requires custodian administrative authority to register and view.",
};

// Evidence ↔ document relationship types (spec §20). Direction is
// DOCUMENT → EVIDENCE ("Forensic report DESCRIBES evidence").
// NOT a knowledge graph (spec §68) — no inference, no graph engine.
export const EVIDENCE_RELATIONSHIP_TYPES = [
  "DESCRIBES",
  "DERIVED_FROM",
  "RESULTS_FROM",
  "SUPPORTS",
  "RELATED",
] as const;
export type EvidenceRelationshipType = (typeof EVIDENCE_RELATIONSHIP_TYPES)[number];

export const EVIDENCE_RELATIONSHIP_NOTES: Record<string, string> = {
  DESCRIBES: "The document describes this evidence item (e.g. forensic report).",
  DERIVED_FROM: "The document was derived from this evidence (e.g. transcript from a recording).",
  RESULTS_FROM: "The document results from examination of this evidence (e.g. lab report).",
  SUPPORTS: "The document supports or corroborates this evidence.",
  RELATED: "General association without a specific direction.",
};

export const EVIDENCE_TITLE_MAX_LENGTH = 200;
export const EVIDENCE_DESCRIPTION_MAX_LENGTH = 2000;
export const EVIDENCE_LOCATION_MAX_LENGTH = 200;
export const EVIDENCE_NOTES_MAX_LENGTH = 1000;
export const EVIDENCE_CATEGORY_MAX_LENGTH = 80;
export const EVIDENCE_NUMBER_MAX_LENGTH = 100;
export const EVIDENCE_SOURCE_REFERENCE_MAX_LENGTH = 100;
export const EVIDENCE_CONDITION_MAX_LENGTH = 300;

// Audit event registry (spec §21/§22). The immutable hash-chained
// audit ledger consumes these; extensible for later phases.
export const AUDIT_EVENT_TYPES = [
  // authentication (spec §22 example set)
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  // evidence lifecycle (spec §21)
  "EVIDENCE_CREATED",
  "EVIDENCE_COMMITTED",
  "EVIDENCE_STATUS_CHANGED",
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "EVIDENCE_TRANSFER_REQUESTED",
  "EVIDENCE_TRANSFER_ACCEPTED",
  "EVIDENCE_TRANSFER_REJECTED",
  "EVIDENCE_TRANSFER_CANCELLED",
  "EVIDENCE_RELATIONSHIP_CREATED",
  "EVIDENCE_ACCESS_DENIED",
  "EVIDENCE_INTEGRITY_VERIFIED",
  // audit & ledger operations — auditing the auditors (spec §34)
  "AUDIT_SEARCHED",
  "AUDIT_EVENT_VIEWED",
  "AUDIT_CHAIN_VERIFIED",
  "AUDIT_ACCESS_DENIED",
  "LEDGER_ANCHORED",
  "LEDGER_ANCHOR_VERIFIED",
  "LEDGER_VERIFY_FAILED",
  // reports (spec §65/§66) — each generation is a new audited instance
  "REPORT_GENERATED",
  "REPORT_ACCESS_DENIED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

// Audit search categories (spec §33/§60)
export const AUDIT_EVENT_CATEGORIES: Record<string, string[]> = {
  AUTHENTICATION: ["LOGIN_SUCCESS", "LOGIN_FAILED", "LOGOUT"],
  EVIDENCE: ["EVIDENCE_CREATED", "EVIDENCE_COMMITTED", "EVIDENCE_STATUS_CHANGED", "EVIDENCE_VIEWED", "EVIDENCE_DOWNLOADED", "EVIDENCE_TRANSFER_REQUESTED", "EVIDENCE_TRANSFER_ACCEPTED", "EVIDENCE_TRANSFER_REJECTED", "EVIDENCE_TRANSFER_CANCELLED", "EVIDENCE_RELATIONSHIP_CREATED", "EVIDENCE_ACCESS_DENIED", "EVIDENCE_INTEGRITY_VERIFIED"],
  AUDIT: ["AUDIT_SEARCHED", "AUDIT_EVENT_VIEWED", "AUDIT_CHAIN_VERIFIED", "AUDIT_ACCESS_DENIED"],
  LEDGER: ["LEDGER_ANCHORED", "LEDGER_ANCHOR_VERIFIED", "LEDGER_VERIFY_FAILED"],
  REPORT: ["REPORT_GENERATED", "REPORT_ACCESS_DENIED"],
};

// Documented genesis hash (spec §27): a defined, inspectable starting
// point — SHA-256 of the fixed genesis seed string. The first audit
// event's previousEventHash is exactly this value.
export const AUDIT_GENESIS_SEED = "AUDIT_GENESIS|central-justice-platform|PHASE-4|v1";
export const AUDIT_HASH_ALGORITHM = "SHA-256";

// Ledger adapters (spec §30/§67). DATABASE is the live MVP adapter;
// HYPERLEDGER_FABRIC is an interface stub — NEVER registered active
// and never claimed as implemented (spec §31/§68/§74).
export const LEDGER_ADAPTERS = ["DATABASE", "HYPERLEDGER_FABRIC"] as const;
export const LEDGER_ACTIVE_ADAPTER = "DATABASE";
export const LEDGER_ANCHOR_STATUSES = ["UNANCHORED", "ANCHORED"] as const;

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
  // Phase 4
  EVIDENCE_NOT_FOUND: "EVIDENCE_NOT_FOUND",
  EVIDENCE_ACCESS_DENIED: "EVIDENCE_ACCESS_DENIED",
  EVIDENCE_IMMUTABLE: "EVIDENCE_IMMUTABLE",
  INVALID_EVIDENCE_TRANSITION: "INVALID_EVIDENCE_TRANSITION",
  INVALID_EVIDENCE_STATE: "INVALID_EVIDENCE_STATE",
  AUDIT_NOT_FOUND: "AUDIT_NOT_FOUND",
  AUDIT_ACCESS_DENIED: "AUDIT_ACCESS_DENIED",
  AUDIT_CHAIN_INVALID: "AUDIT_CHAIN_INVALID",
  LEDGER_ERROR: "LEDGER_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
