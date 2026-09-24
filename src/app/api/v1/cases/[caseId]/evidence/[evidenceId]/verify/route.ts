import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertEvidenceViewable } from "@/lib/evidence/workflows";
import { verifyEvidenceIntegrity } from "@/lib/evidence/service";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/evidence/{evidenceId}/verify —
// controlled integrity verification (spec §13/§40): decrypt the
// stored object, recompute SHA-256, compare with the frozen
// fingerprint. SYSTEM_ADMIN-only backend operation — NOT a
// user-facing tamper badge (mirrors the Phase 3 document verifier).
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    if (ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, "FORBIDDEN", "Only the platform administrator can run integrity verification.");
    }
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence } = await assertEvidenceViewable(ctx, caseId, evidenceId, "verify");

    const result = await verifyEvidenceIntegrity({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      evidence: {
        id: evidence.id,
        evidenceId: evidence.evidenceId,
        storageKey: evidence.storageKey,
        sha256Hash: evidence.sha256Hash,
        hasDigitalContent: evidence.hasDigitalContent,
      },
    });

    return jsonOk({
      evidenceId: evidence.evidenceId,
      hasDigitalContent: result.hasDigitalContent,
      hashAlgorithm: evidence.hashAlgorithm,
      verificationResult: !result.hasDigitalContent ? "NOT_APPLICABLE_PHYSICAL" : result.match ? "MATCH" : "MISMATCH",
      recordedHash: result.recordedHash,
      computedHash: result.computedHash,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
