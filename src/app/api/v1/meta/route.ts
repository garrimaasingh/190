import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DEPARTMENT_TYPES,
  DEPARTMENT_STATUSES,
  OFFICER_ROLES,
  OFFICER_STATUSES,
  OFFICER_STATUS_TRANSITIONS,
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CASE_STATUS_TRANSITIONS,
  PARTICIPATION_TYPES,
  CASE_OFFICER_ROLES,
  CASE_OFFICER_STATUSES,
  TRANSFER_STATUSES,
  CASE_EVENT_TYPES,
} from "@/lib/constants";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export const runtime = "nodejs";

// GET /api/v1/meta — controlled reference/enumeration data (spec §6/§13).
// The frontend loads these from the API and never hard-codes them.
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.PROFILE_READ);
    return jsonOk({
      departmentTypes: DEPARTMENT_TYPES,
      departmentStatuses: DEPARTMENT_STATUSES,
      officerRoles: OFFICER_ROLES,
      officerStatuses: OFFICER_STATUSES,
      officerStatusTransitions: OFFICER_STATUS_TRANSITIONS,
      rolePermissions: ROLE_PERMISSIONS,
      // Phase 2 — case reference data (spec §6/§7/§8/§12/§13/§19)
      caseTypes: CASE_TYPES,
      casePriorities: CASE_PRIORITIES,
      caseStatuses: CASE_STATUSES,
      caseStatusTransitions: CASE_STATUS_TRANSITIONS,
      participationTypes: PARTICIPATION_TYPES,
      caseOfficerRoles: CASE_OFFICER_ROLES,
      caseOfficerStatuses: CASE_OFFICER_STATUSES,
      transferStatuses: TRANSFER_STATUSES,
      caseEventTypes: CASE_EVENT_TYPES,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
