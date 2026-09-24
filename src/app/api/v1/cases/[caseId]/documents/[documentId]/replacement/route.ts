import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { handleRelatedDocumentUpload } from "@/lib/documents/workflows";
import { handleApiError } from "@/lib/api";

export const runtime = "nodejs";

// POST /api/v1/cases/{caseId}/documents/{documentId}/replacement
// (spec §39): creates the designated successor document and marks
// the original SUPERSEDED — stored, visible per policy, never deleted.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_UPLOAD);
    const { caseId, documentId } = await params;
    return await handleRelatedDocumentUpload(req, ctx, caseId, documentId, "REPLACEMENT");
  } catch (err) {
    return handleApiError(err);
  }
}
