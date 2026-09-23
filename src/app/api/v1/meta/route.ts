import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DEPARTMENT_TYPES,
  DEPARTMENT_STATUSES,
  OFFICER_ROLES,
  OFFICER_STATUSES,
  OFFICER_STATUS_TRANSITIONS,
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
    });
  } catch (err) {
    return handleApiError(err);
  }
}
