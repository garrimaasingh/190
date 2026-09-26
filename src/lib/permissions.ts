// ============================================================
// Role → Permission model (spec §13/§14).
// Permissions are declared once here; every API route and UI
// guard consults this registry instead of scattering role
// strings through the code.
// Future-phase permissions (case.*, document.*) are
// intentionally NOT defined yet (spec §14).
// ============================================================

export const PERMISSIONS = {
  // department
  DEPARTMENT_READ: "department.read",
  DEPARTMENT_CREATE: "department.create",
  DEPARTMENT_UPDATE: "department.update",
  DEPARTMENT_STATUS_UPDATE: "department.status.update",
  // officers
  OFFICER_READ: "officer.read",
  OFFICER_CREATE: "officer.create",
  OFFICER_UPDATE: "officer.update",
  OFFICER_ACTIVATE: "officer.activate",
  OFFICER_DEACTIVATE: "officer.deactivate",
  // profile
  PROFILE_READ: "profile.read",
  PROFILE_UPDATE: "profile.update",
  PASSWORD_UPDATE: "password.update",
  // organization / platform
  ORG_READ: "org.read",
  ORG_MANAGE: "org.manage",
  PLATFORM_STATS_READ: "platform.stats.read",
  EVENTS_READ: "events.read",
  LOGO_UPDATE: "logo.update",
  // Phase 2 — cases. Role permission is necessary but NOT sufficient:
  // every case API additionally enforces case-level access
  // (custodian / participation / explicit assignment) in
  // src/lib/cases/access.ts (spec §14/§46).
  CASE_READ: "case.read",
  CASE_CREATE: "case.create",
  CASE_UPDATE: "case.update",
  CASE_STATUS_UPDATE: "case.status.update",
  CASE_OFFICER_MANAGE: "case.officer.manage",
  CASE_DEPARTMENT_MANAGE: "case.department.manage",
  CASE_TRANSFER_INITIATE: "case.transfer.initiate",
  CASE_TRANSFER_DECIDE: "case.transfer.decide",
  // Phase 3 — documents & evidence. Role permission is necessary but
  // NOT sufficient: every route additionally enforces case-level
  // access (view for reads, manage for mutations).
  DOCUMENT_READ: "document.read",
  DOCUMENT_UPLOAD: "document.upload",
  DOCUMENT_DELETE: "document.delete",
  EVIDENCE_READ: "evidence.read",
  EVIDENCE_MANAGE: "evidence.manage",
  // Phase 4 — evidence custody, immutable audit, ledger, reports.
  // Same necessity rule: audit/ledger routes additionally enforce
  // role, and evidence routes enforce case + evidence-level access.
  EVIDENCE_TRANSFER_INITIATE: "evidence.transfer.initiate",
  EVIDENCE_TRANSFER_DECIDE: "evidence.transfer.decide",
  AUDIT_READ: "audit.read",
  AUDIT_VERIFY: "audit.verify",
  LEDGER_MANAGE: "ledger.manage",
  REPORT_GENERATE: "report.generate",
  // Phase 5 — AI document intelligence. Role permission is necessary
  // but NOT sufficient: AI routes additionally enforce case access
  // AND document classification clearance server-side (spec §22/§34).
  // AI_USE covers assistive operations (process/search/ask/view);
  // AI_REVIEW covers human verification of AI results (spec §30);
  // AI_CONFIGURE covers administrative configuration (spec §56).
  AI_USE: "ai.use",
  AI_REVIEW: "ai.review",
  AI_CONFIGURE: "ai.configure",
  // Phase 8 — inter-department integration (spec §38). Role
  // permission is necessary but NOT sufficient: every integration
  // route additionally enforces DEPARTMENT SCOPING against the
  // connection owner (src/lib/integrations/authorization.ts) and
  // case-level access on import/export targets.
  INTEGRATION_READ: "integration.read",
  INTEGRATION_CONFIGURE: "integration.configure",
  INTEGRATION_TEST: "integration.test",
  INTEGRATION_IMPORT: "integration.import",
  INTEGRATION_EXPORT: "integration.export",
  INTEGRATION_RESOLVE_CONFLICT: "integration.resolve_conflict",
  INTEGRATION_ADMIN: "integration.admin",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const SYSTEM_ADMIN: Permission[] = [
  PERMISSIONS.DEPARTMENT_READ,
  PERMISSIONS.DEPARTMENT_CREATE,
  PERMISSIONS.DEPARTMENT_UPDATE,
  PERMISSIONS.DEPARTMENT_STATUS_UPDATE,
  PERMISSIONS.OFFICER_READ,
  PERMISSIONS.OFFICER_CREATE,
  PERMISSIONS.OFFICER_UPDATE,
  PERMISSIONS.OFFICER_ACTIVATE,
  PERMISSIONS.OFFICER_DEACTIVATE,
  PERMISSIONS.PROFILE_READ,
  PERMISSIONS.PROFILE_UPDATE,
  PERMISSIONS.PASSWORD_UPDATE,
  PERMISSIONS.ORG_READ,
  PERMISSIONS.ORG_MANAGE,
  PERMISSIONS.PLATFORM_STATS_READ,
  PERMISSIONS.EVENTS_READ,
  PERMISSIONS.LOGO_UPDATE,
  PERMISSIONS.CASE_READ,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_STATUS_UPDATE,
  PERMISSIONS.CASE_OFFICER_MANAGE,
  PERMISSIONS.CASE_DEPARTMENT_MANAGE,
  PERMISSIONS.CASE_TRANSFER_INITIATE,
  PERMISSIONS.CASE_TRANSFER_DECIDE,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.DOCUMENT_UPLOAD,
  PERMISSIONS.DOCUMENT_DELETE,
  PERMISSIONS.EVIDENCE_READ,
  PERMISSIONS.EVIDENCE_MANAGE,
  PERMISSIONS.EVIDENCE_TRANSFER_INITIATE,
  PERMISSIONS.EVIDENCE_TRANSFER_DECIDE,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.AUDIT_VERIFY,
  PERMISSIONS.LEDGER_MANAGE,
  PERMISSIONS.REPORT_GENERATE,
  PERMISSIONS.AI_USE,
  PERMISSIONS.AI_REVIEW,
  PERMISSIONS.AI_CONFIGURE,
  PERMISSIONS.INTEGRATION_READ,
  PERMISSIONS.INTEGRATION_CONFIGURE,
  PERMISSIONS.INTEGRATION_TEST,
  PERMISSIONS.INTEGRATION_IMPORT,
  PERMISSIONS.INTEGRATION_EXPORT,
  PERMISSIONS.INTEGRATION_RESOLVE_CONFLICT,
  PERMISSIONS.INTEGRATION_ADMIN,
];

const DEPARTMENT_ADMIN: Permission[] = [
  PERMISSIONS.DEPARTMENT_READ,
  PERMISSIONS.DEPARTMENT_UPDATE,
  PERMISSIONS.DEPARTMENT_STATUS_UPDATE,
  PERMISSIONS.OFFICER_READ,
  PERMISSIONS.OFFICER_CREATE,
  PERMISSIONS.OFFICER_UPDATE,
  PERMISSIONS.OFFICER_ACTIVATE,
  PERMISSIONS.OFFICER_DEACTIVATE,
  PERMISSIONS.PROFILE_READ,
  PERMISSIONS.PROFILE_UPDATE,
  PERMISSIONS.PASSWORD_UPDATE,
  PERMISSIONS.ORG_READ,
  PERMISSIONS.LOGO_UPDATE,
  PERMISSIONS.CASE_READ,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_STATUS_UPDATE,
  PERMISSIONS.CASE_OFFICER_MANAGE,
  PERMISSIONS.CASE_DEPARTMENT_MANAGE,
  PERMISSIONS.CASE_TRANSFER_INITIATE,
  PERMISSIONS.CASE_TRANSFER_DECIDE,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.DOCUMENT_UPLOAD,
  PERMISSIONS.DOCUMENT_DELETE,
  PERMISSIONS.EVIDENCE_READ,
  PERMISSIONS.EVIDENCE_MANAGE,
  PERMISSIONS.EVIDENCE_TRANSFER_INITIATE,
  PERMISSIONS.EVIDENCE_TRANSFER_DECIDE,
  PERMISSIONS.REPORT_GENERATE,
  PERMISSIONS.AI_USE,
  PERMISSIONS.AI_REVIEW,
  // Phase 8: department-scoped integration operations (spec §38).
  // Configure is capped: a department admin may only configure
  // DEPARTMENT-scoped connections (enforced in authorization.ts).
  PERMISSIONS.INTEGRATION_READ,
  PERMISSIONS.INTEGRATION_CONFIGURE,
  PERMISSIONS.INTEGRATION_TEST,
  PERMISSIONS.INTEGRATION_IMPORT,
  PERMISSIONS.INTEGRATION_EXPORT,
  PERMISSIONS.INTEGRATION_RESOLVE_CONFLICT,
];

const OFFICER: Permission[] = [
  PERMISSIONS.DEPARTMENT_READ,
  PERMISSIONS.OFFICER_READ,
  PERMISSIONS.PROFILE_READ,
  PERMISSIONS.PROFILE_UPDATE,
  PERMISSIONS.PASSWORD_UPDATE,
  PERMISSIONS.ORG_READ,
  PERMISSIONS.CASE_READ,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_STATUS_UPDATE,
  PERMISSIONS.CASE_OFFICER_MANAGE,
  PERMISSIONS.CASE_TRANSFER_INITIATE,
  PERMISSIONS.CASE_TRANSFER_DECIDE,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.DOCUMENT_UPLOAD,
  PERMISSIONS.DOCUMENT_DELETE,
  PERMISSIONS.EVIDENCE_READ,
  PERMISSIONS.EVIDENCE_MANAGE,
  PERMISSIONS.EVIDENCE_TRANSFER_INITIATE,
  PERMISSIONS.EVIDENCE_TRANSFER_DECIDE,
  PERMISSIONS.REPORT_GENERATE,
  PERMISSIONS.AI_USE,
];

const AUDITOR: Permission[] = [
  PERMISSIONS.DEPARTMENT_READ,
  PERMISSIONS.OFFICER_READ,
  PERMISSIONS.PROFILE_READ,
  PERMISSIONS.ORG_READ,
  PERMISSIONS.PLATFORM_STATS_READ,
  PERMISSIONS.EVENTS_READ,
  PERMISSIONS.CASE_READ, // read-only by policy — no case mutation permission is granted
  PERMISSIONS.DOCUMENT_READ, // audit visibility includes documents & evidence
  PERMISSIONS.EVIDENCE_READ,
  PERMISSIONS.AUDIT_READ, // Phase 4: search/inspect the immutable audit trail
  PERMISSIONS.AUDIT_VERIFY, // Phase 4: run chain verification (read-only operation)
  PERMISSIONS.REPORT_GENERATE, // Phase 4: read-level report generation
  PERMISSIONS.AI_USE, // Phase 5: assistive AI (search/ask/view) — clearance still applies
  PERMISSIONS.INTEGRATION_READ, // Phase 8: read-only integration history (spec §38)
  // Deliberately ABSENT: AI_REVIEW (auditors observe, they do not verify AI results —
  // verification is an operational act), AI_CONFIGURE, audit mutation (does not exist),
  // case/document/evidence write permissions, LEDGER_MANAGE,
  // integration configure/test/import/export/admin (spec §38: AUDITOR is read-only).
];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  SYSTEM_ADMIN: SYSTEM_ADMIN,
  DEPARTMENT_ADMIN: DEPARTMENT_ADMIN,
  OFFICER: OFFICER,
  AUDITOR: AUDITOR,
};

export function roleHas(role: string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

export function permissionsForRole(role: string): Permission[] {
  return ROLE_PERMISSIONS[role] || [];
}
