import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateCaseStatusSchema } from "@/lib/validation";
import { assertCaseManageWithPermission } from "@/lib/cases/access";
import { changeStatus } from "@/lib/cases/status";

export const runtime = "nodejs";

// PATCH /api/v1/cases/{caseId}/status — controlled lifecycle transition
// (spec §8/§37). The transition engine validates and records; the
// frontend can never assign arbitrary statuses.
export async function PATCH(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_STATUS_UPDATE);
    const { caseId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_STATUS_UPDATE);

    const body = await req.json().catch(() => ({}));
    const { status } = updateCaseStatusSchema.parse(body);

    const updated = await changeStatus(caseRow.id, status, ctx);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
