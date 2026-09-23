import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/eligible-officers?departmentId=…&purpose=assign|transfer
//
// Phase 2 case-scoped officer lookup (spec §21/§29). Phase 1's department
// officers listing is scope-locked to the caller's own department — case
// workflows legitimately need ACTIVE officers of OTHER participating
// departments (assignment) or the transfer destination (receiving officer),
// so this endpoint provides it under case-level authorization:
//   - purpose=assign:  department must be an ACTIVE case participant; case view access required
//   - purpose=transfer: department is the intended destination; case manage access required
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);

    const url = new URL(req.url);
    const departmentId = url.searchParams.get("departmentId") || "";
    const purpose = url.searchParams.get("purpose") === "transfer" ? "transfer" : "assign";

    if (!departmentId) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "departmentId is required.");
    }

    if (purpose === "assign") {
      if (!access.view) {
        throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
      }
      const participating = caseRow.departments.some(
        (d) => d.departmentId === departmentId && d.status === "ACTIVE"
      );
      if (!participating) {
        throw new ApiError(
          422,
          ERROR_CODES.DEPARTMENT_INELIGIBLE,
          "Officers can only be listed for departments participating in this case."
        );
      }
    } else {
      if (!access.manage) {
        throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to manage this case.");
      }
    }

    const officers = await db.officer.findMany({
      where: { departmentId, status: "ACTIVE" },
      select: {
        id: true,
        officerId: true,
        name: true,
        designation: true,
        status: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
      take: 100,
    });

    return jsonOk({ items: officers });
  } catch (err) {
    return handleApiError(err);
  }
}
