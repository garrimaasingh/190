import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loadEvidenceForView } from "@/lib/evidence/workflows";
import { canViewEvidence } from "@/lib/evidence/authorization";
import { createEvidenceTransferRequest, getEvidenceCustodyChain } from "@/lib/evidence/custody";
import { evidenceTransferCreateSchema } from "@/lib/validation";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// GET  /api/v1/cases/{caseId}/evidence/{evidenceId}/transfers —
//      chain-of-custody history (spec §18): COLLECTED record +
//      every transfer record, chronological, immutable.
// POST /api/v1/cases/{caseId}/evidence/{evidenceId}/transfers —
//      request a custody transfer (spec §16/§44). Only the current
//      custodian initiates; custody flips to TRANSFER_PENDING.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence, access } = await loadEvidenceForView(ctx, caseId, evidenceId);
    if (!canViewEvidence(ctx, access, evidence.classification, evidence.currentCustodianDepartmentId)) {
      throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, "You are not authorized to access this evidence.");
    }

    const custody = await getEvidenceCustodyChain(evidence.id);
    return jsonOk(custody);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_TRANSFER_INITIATE);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence } = await loadEvidenceForView(ctx, caseId, evidenceId);

    const body = await req.json().catch(() => ({}));
    const input = evidenceTransferCreateSchema.parse(body);

    const transfer = await createEvidenceTransferRequest({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      evidence: { id: evidence.id, evidenceId: evidence.evidenceId, title: evidence.title, status: evidence.status, currentCustodianDepartmentId: evidence.currentCustodianDepartmentId },
      input,
    });

    return jsonOk({ transfer }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
