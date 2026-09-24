import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { listAllowedTransitions } from "@/lib/cases/status";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/access — the viewer's own case-level access,
// with a human-readable explanation (spec §14/§26 "Access" section).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);

    // Case metadata (even the ID) must not leak to unauthorized callers.
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    return jsonOk({
      caseId: caseRow.caseId,
      level: access.level,
      view: access.view,
      manage: access.manage,
      isCustodianSide: access.isCustodianSide,
      isOriginSide: access.isOriginSide,
      assigned: access.assigned,
      reasons: access.reasons,
      allowedTransitions: access.manage ? listAllowedTransitions(caseRow.status) : [],
    });
  } catch (err) {
    return handleApiError(err);
  }
}
