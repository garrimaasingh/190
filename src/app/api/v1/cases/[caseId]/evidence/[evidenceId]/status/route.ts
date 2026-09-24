import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { loadEvidenceForView } from "@/lib/evidence/workflows";
import { canChangeEvidenceStatus } from "@/lib/evidence/authorization";
import { changeEvidenceStatus, toEvidenceSummary } from "@/lib/evidence/service";
import { evidenceStatusChangeSchema } from "@/lib/validation";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/evidence/{evidenceId}/status —
// CONTROLLED status change (spec §8). The transition map decides —
// the frontend can never set arbitrary statuses. TRANSFER_PENDING
// is service-managed and rejected here. Status change + its audit
// event commit atomically (spec §48/§49).
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_MANAGE);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence, access } = await loadEvidenceForView(ctx, caseId, evidenceId);

    const body = await req.json().catch(() => ({}));
    const input = evidenceStatusChangeSchema.parse(body);

    const gate = canChangeEvidenceStatus(ctx, access, evidence.status);
    if (!gate.allowed) {
      throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, gate.reason || "Status change not permitted.");
    }

    const updated = await changeEvidenceStatus({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      evidence: { id: evidence.id, evidenceId: evidence.evidenceId, status: evidence.status, title: evidence.title },
      requestedStatus: input.status,
      reason: input.reason ?? null,
    });

    return jsonOk({ evidence: toEvidenceSummary(updated, caseRow.caseId) });
  } catch (err) {
    return handleApiError(err);
  }
}
