import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { DocumentStorage } from "@/lib/documents/storage";
import { decryptDocument } from "@/lib/documents/encryption";
import { recordDocumentEvent } from "@/lib/documents/events";
import { handleApiError } from "@/lib/api";
import { sanitizeOriginalFilename } from "@/lib/documents/validation";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/documents/{documentId}/download
// Controlled download (spec §32/§48/§78).
//
// Event interface per download attempt (spec §32):
//   DOCUMENT_DOWNLOAD_REQUESTED → COMPLETED | FAILED
// Bytes are decrypted server-side and streamed with an attachment
// disposition; the storage layer's key-shape validation rejects any
// manipulated identifier before filesystem access.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "download");

    const actor = {
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
    };

    await recordDocumentEvent({
      eventType: "DOCUMENT_DOWNLOAD_REQUESTED",
      caseId: caseRow.id,
      documentId: doc.id,
      result: "SUCCESS",
      ...actor,
      metadata: { documentId: doc.documentId },
    });

    try {
      const stored = await DocumentStorage.get_object(doc.storageKey);
      const plaintext = decryptDocument(stored);
      const safeName = sanitizeOriginalFilename(doc.originalFilename);
      await recordDocumentEvent({
        eventType: "DOCUMENT_DOWNLOAD_COMPLETED",
        caseId: caseRow.id,
        documentId: doc.id,
        result: "SUCCESS",
        ...actor,
        metadata: { documentId: doc.documentId, fileSize: doc.fileSize },
      });
      return new Response(new Uint8Array(plaintext), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(plaintext.length),
          "Content-Disposition": `attachment; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      await recordDocumentEvent({
        eventType: "DOCUMENT_DOWNLOAD_FAILED",
        caseId: caseRow.id,
        documentId: doc.id,
        result: "FAILED",
        ...actor,
        metadata: { documentId: doc.documentId },
      });
      console.error("[document-download] stream failure", err);
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Document could not be retrieved from secure storage." } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
