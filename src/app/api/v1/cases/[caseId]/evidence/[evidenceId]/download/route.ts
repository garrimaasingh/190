import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertEvidenceViewable } from "@/lib/evidence/workflows";
import { DocumentStorage } from "@/lib/documents/storage";
import { decryptDocument } from "@/lib/documents/encryption";
import { sanitizeOriginalFilename } from "@/lib/documents/validation";
import { recordAuditEvent } from "@/lib/audit/service";
import { handleApiError } from "@/lib/api";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/evidence/{evidenceId}/download —
// controlled download of DIGITAL evidence (spec §11/§13/§37).
// EVIDENCE_DOWNLOADED records SUCCESS/FAILED per attempt (spec §21).
// Bytes are decrypted server-side, streamed as attachment; storage
// key validation rejects any manipulated identifier pre-FS.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence } = await assertEvidenceViewable(ctx, caseId, evidenceId, "download");

    if (!evidence.hasDigitalContent || !evidence.storageKey) {
      return new Response(
        JSON.stringify({ error: { code: "EVIDENCE_NOT_FOUND", message: "This evidence item has no digital content to download." } }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const stored = await DocumentStorage.get_object(evidence.storageKey);
      const plaintext = decryptDocument(stored);
      const safeName = sanitizeOriginalFilename(evidence.originalFilename || evidence.evidenceId);
      await recordAuditEvent({
        eventType: "EVIDENCE_DOWNLOADED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        metadata: { evidenceId: evidence.evidenceId, fileSize: evidence.fileSize },
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
      await recordAuditEvent({
        eventType: "EVIDENCE_DOWNLOADED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { evidenceId: evidence.evidenceId, reason: "storage retrieval failed" },
      });
      console.error("[evidence-download] stream failure", err);
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Evidence could not be retrieved from secure storage." } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
