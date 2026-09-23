import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseView } from "@/lib/cases/access";
import { acceptTransfer } from "@/lib/cases/custody";

export const runtime = "nodejs";

// POST /api/v1/cases/{caseId}/transfers/{transferId}/accept (spec §21/§43).
// Only ACCEPTED transfers change the current custodian. Guarded, atomic.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ caseId: string; transferId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_TRANSFER_DECIDE);
    const { caseId, transferId } = await params;

    // The receiving department may not be a case participant yet — resolve
    // the case for view first (destination actors get view via their
    // role on the transfer decision path inside the service).
    const { caseRow } = await assertCaseView(ctx, caseId);

    const transfer = await acceptTransfer(ctx, caseRow.id, transferId);
    return jsonOk(transfer);
  } catch (err) {
    return handleApiError(err);
  }
}
