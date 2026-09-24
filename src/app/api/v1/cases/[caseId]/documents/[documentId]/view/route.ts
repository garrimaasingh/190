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
// GET /api/v1/cases/{caseId}/documents/{documentId}/view
// Secure inline viewer stream (spec §31/§46/§47/§62).
//
// - Authorization FIRST; denied access is audited (DOCUMENT_ACCESS_DENIED)
// - Bytes are decrypted server-side and streamed — raw storage URLs
//   are never exposed (spec §31)
// - `Content-Security-Policy: sandbox` + nosniff isolate rendered
//   PDFs/images (spec §46): embedded scripts cannot execute
// - QUARANTINED records are not viewable (route guard denies)
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    await recordDocumentEvent({
      eventType: "DOCUMENT_VIEWED",
      caseId: caseRow.id,
      documentId: doc.id,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "SUCCESS",
      metadata: { documentId: doc.documentId }, // no document content in events (spec §33)
    });

    try {
      const stored = await DocumentStorage.get_object(doc.storageKey);
      const plaintext = decryptDocument(stored);
      const safeName = sanitizeOriginalFilename(doc.originalFilename);
      return new Response(new Uint8Array(plaintext), {
        status: 200,
        headers: {
          "Content-Type": doc.mimeType,
          "Content-Length": String(plaintext.length),
          "Content-Disposition": `inline; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          // §46: the document document is served sandboxed — scripts can never
          // execute, but same-origin is retained so the built-in PDF renderer
          // may attach (defense-in-depth alongside the frame-level sandbox).
          "Content-Security-Policy": "sandbox allow-same-origin",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      await recordDocumentEvent({
        eventType: "DOCUMENT_DOWNLOAD_FAILED",
        caseId: caseRow.id,
        documentId: doc.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { documentId: doc.documentId, action: "view" },
      });
      console.error("[document-view] stream failure", err);
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Document could not be retrieved from secure storage." } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
