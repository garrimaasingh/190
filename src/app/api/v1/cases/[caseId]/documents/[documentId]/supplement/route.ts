import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { handleRelatedDocumentUpload } from "@/lib/documents/workflows";
import { handleApiError } from "@/lib/api";

export const runtime = "nodejs";

// POST /api/v1/cases/{caseId}/documents/{documentId}/supplement
// (spec §37): creates a NEW immutable document that adds
// information to the original; the original remains unchanged.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_UPLOAD);
    const { caseId, documentId } = await params;
    return await handleRelatedDocumentUpload(req, ctx, caseId, documentId, "SUPPLEMENT");
  } catch (err) {
    return handleApiError(err);
  }
}
