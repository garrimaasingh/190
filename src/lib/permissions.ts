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
];

const AUDITOR: Permission[] = [
  PERMISSIONS.DEPARTMENT_READ,
  PERMISSIONS.OFFICER_READ,
  PERMISSIONS.PROFILE_READ,
  PERMISSIONS.ORG_READ,
  PERMISSIONS.PLATFORM_STATS_READ,
  PERMISSIONS.EVENTS_READ,
  PERMISSIONS.CASE_READ, // read-only by policy — no case mutation permission is granted
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
