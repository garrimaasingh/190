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
  // Phase 3+ (registered for forward compatibility, not emitted yet):
  "DOCUMENT_UPLOADED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_DOWNLOADED",
  "EVIDENCE_SUBMITTED",
] as const;
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];

export const CASE_NUMBER_MAX_LENGTH = 64;
export const CASE_TITLE_MAX_LENGTH = 200;
export const CASE_DESCRIPTION_MAX_LENGTH = 4000;

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
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
