import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseView } from "@/lib/cases/access";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/transfers/{transferId} — single custody event.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ caseId: string; transferId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId, transferId } = await params;

    const { caseRow } = await assertCaseView(ctx, caseId);

    const transfer = await db.caseTransfer.findFirst({
      where: { caseId: caseRow.id, OR: [{ transferId }, { id: transferId }] },
      include: {
        fromDepartment: { select: { id: true, name: true, departmentType: true } },
        toDepartment: { select: { id: true, name: true, departmentType: true } },
        requestedByOfficer: { select: { officerId: true, name: true } },
        acceptedByOfficer: { select: { officerId: true, name: true } },
        toOfficer: { select: { officerId: true, name: true } },
      },
    });
    if (!transfer) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Transfer not found.");

    return jsonOk(transfer);
  } catch (err) {
    return handleApiError(err);
  }
}
