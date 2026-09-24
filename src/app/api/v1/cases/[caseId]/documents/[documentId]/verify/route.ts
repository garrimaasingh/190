import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { verifyDocumentIntegrity } from "@/lib/documents/service";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/documents/{documentId}/verify
// Controlled integrity verification (spec §21).
//
// SYSTEM_ADMIN backend process only — deliberately NOT a user
// dashboard feature that recalculates hashes for a "TAMPERED"
// badge (spec §21). Recomputes SHA-256 over the decrypted stored
// object and compares it with the recorded immutable fingerprint;
// the outcome is audited (DOCUMENT_INTEGRITY_VERIFIED).
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    if (ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, ERROR_CODES.FORBIDDEN, "Integrity verification is a platform-administration process.");
    }
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "verify");

    const result = await verifyDocumentIntegrity({
      ctx,
      document: {
        id: doc.id,
        documentId: doc.documentId,
        caseId: caseRow.id,
        casePublicId: caseRow.caseId,
        storageKey: doc.storageKey,
        sha256Hash: doc.sha256Hash,
      },
    });

    return jsonOk({
      documentId: doc.documentId,
      match: result.match,
      recordedHash: result.recordedHash,
      computedHash: result.computedHash,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
