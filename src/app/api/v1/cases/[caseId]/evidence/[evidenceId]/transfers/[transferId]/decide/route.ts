import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { decideEvidenceTransfer } from "@/lib/evidence/custody";
import { evidenceTransferDecisionSchema } from "@/lib/validation";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/evidence/{evidenceId}/transfers/{transferId}/decide
// Accept / reject / cancel an evidence custody transfer (spec §16/
// §17/§44). Receiving department decides accept/reject; requesting
// custodian cancels; only REQUESTED transfers are decidable; only
// ACCEPT changes custody. Decision + custody swap + audit events are
// one transaction (spec §48/§49).
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string; transferId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_TRANSFER_DECIDE);
    const { transferId } = await params;

    const body = await req.json().catch(() => ({}));
    const { action } = evidenceTransferDecisionSchema.parse(body);

    const transfer = await decideEvidenceTransfer({ ctx, transferRef: transferId, action });
    return jsonOk({ transfer });
  } catch (err) {
    return handleApiError(err);
  }
}
