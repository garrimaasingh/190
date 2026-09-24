import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseView } from "@/lib/cases/access";
import { cancelTransfer } from "@/lib/cases/custody";

export const runtime = "nodejs";

// POST /api/v1/cases/{caseId}/transfers/{transferId}/cancel (spec §22).
// Only the requesting (custodian) side or the platform administrator may cancel.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ caseId: string; transferId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_TRANSFER_INITIATE);
    const { caseId, transferId } = await params;

    const { caseRow } = await assertCaseView(ctx, caseId);
    const transfer = await cancelTransfer(ctx, caseRow.id, transferId);
    return jsonOk(transfer);
  } catch (err) {
    return handleApiError(err);
  }
}
