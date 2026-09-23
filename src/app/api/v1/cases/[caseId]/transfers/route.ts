import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createTransferSchema } from "@/lib/validation";
import { assertCaseManage, assertCaseView } from "@/lib/cases/access";
import {
  createTransferRequest,
  getCustodyHistory,
} from "@/lib/cases/custody";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/cases/{caseId}/transfers — request custody transfer
// (spec §18/§21). Creates a REQUESTED transfer; custody changes only on
// acceptance by the destination department.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_TRANSFER_INITIATE);
    const { caseId } = await params;

    // Manage access on the case (custodian side / platform admin).
    await assertCaseManage(ctx, caseId);

    const body = await req.json().catch(() => ({}));
    const data = createTransferSchema.parse(body);

    // assertCaseManage resolved by public caseId — recover internal id.
    const caseRow = await db.case.findFirst({
      where: { OR: [{ caseId }, { id: caseId }] },
      select: { id: true },
    });
    if (!caseRow) throw new ApiError(404, ERROR_CODES.CASE_NOT_FOUND, "Case not found.");

    const transfer = await createTransferRequest(ctx, caseRow.id, {
      toDepartmentId: data.toDepartmentId,
      toOfficerId: data.toOfficerId ?? null,
      reason: data.reason,
      transferNotes: data.transferNotes ?? null,
    });

    return jsonOk(
      {
        id: transfer.id,
        transferId: transfer.transferId,
        status: transfer.status,
        fromDepartmentId: transfer.fromDepartmentId,
        toDepartmentId: transfer.toDepartmentId,
        requestedAt: transfer.requestedAt,
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// GET /api/v1/cases/{caseId}/transfers — custody history (spec §23).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow } = await assertCaseView(ctx, caseId);

    const history = await getCustodyHistory(caseRow.id);
    return jsonOk({ items: history });
  } catch (err) {
    return handleApiError(err);
  }
}
