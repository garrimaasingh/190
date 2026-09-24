import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loadEvidenceForView } from "@/lib/evidence/workflows";
import { canViewEvidence, canCreateEvidenceRelationship } from "@/lib/evidence/authorization";
import { linkEvidenceDocument } from "@/lib/evidence/relationships";
import { evidenceRelationshipSchema } from "@/lib/validation";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// GET  /api/v1/cases/{caseId}/evidence/{evidenceId}/relationships
// POST /api/v1/cases/{caseId}/evidence/{evidenceId}/relationships
// Evidence↔document links (spec §20). POST is custodian authority;
// cross-case documents are 404 (never confirm out-of-case existence);
// duplicates are 409; the actor must hold clearance on BOTH ends.
// Creation is audited (EVIDENCE_RELATIONSHIP_CREATED) atomically.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence, access } = await loadEvidenceForView(ctx, caseId, evidenceId);
    if (!canViewEvidence(ctx, access, evidence.classification, evidence.currentCustodianDepartmentId)) {
      throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, "You are not authorized to access this evidence.");
    }

    const { listEvidenceRelationships } = await import("@/lib/evidence/relationships");
    const relationships = await listEvidenceRelationships(evidence.id);
    return jsonOk({ relationships });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_MANAGE);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence, access } = await loadEvidenceForView(ctx, caseId, evidenceId);

    const body = await req.json().catch(() => ({}));
    const input = evidenceRelationshipSchema.parse(body);

    const gate = canCreateEvidenceRelationship(ctx, access, caseRow.status);
    if (!gate.allowed) {
      throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, gate.reason || "Relationship creation not permitted.");
    }

    const result = await linkEvidenceDocument({
      ctx,
      access,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId },
      evidence: { id: evidence.id, evidenceId: evidence.evidenceId, classification: evidence.classification },
      input,
    });

    return jsonOk(result, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
