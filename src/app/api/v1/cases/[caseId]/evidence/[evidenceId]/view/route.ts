import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertEvidenceViewable } from "@/lib/evidence/workflows";
import { DocumentStorage } from "@/lib/documents/storage";
import { decryptDocument } from "@/lib/documents/encryption";
import { recordAuditEvent } from "@/lib/audit/service";
import { handleApiError } from "@/lib/api";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/evidence/{evidenceId}/view — inline
// secure viewing of DIGITAL evidence (spec §11/§13/§40 analog of the
// Phase 3 viewer). Decrypts server-side and streams with a sandboxed
// CSP + nosniff; physical evidence (no binary) returns 404.
// EVIDENCE_VIEWED is recorded best-effort before streaming.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence } = await assertEvidenceViewable(ctx, caseId, evidenceId, "view");

    if (!evidence.hasDigitalContent || !evidence.storageKey) {
      return new Response(
        JSON.stringify({ error: { code: "EVIDENCE_NOT_FOUND", message: "This evidence item has no digital content to view." } }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    await recordAuditEvent({
      eventType: "EVIDENCE_VIEWED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      evidenceId: evidence.evidenceId,
      sessionId: ctx.sessionId,
      metadata: { evidenceId: evidence.evidenceId, action: "view" },
    });

    try {
      const stored = await DocumentStorage.get_object(evidence.storageKey);
      const plaintext = decryptDocument(stored);
      return new Response(new Uint8Array(plaintext), {
        status: 200,
        headers: {
          "Content-Type": evidence.mimeType || "application/octet-stream",
          "Content-Length": String(plaintext.length),
          "Content-Disposition": "inline",
          // Sandboxed inline viewing — no same-origin script execution,
          // no cross-origin window access (mirrors the Phase 3 viewer).
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox allow-same-origin; object-src 'none'",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error("[evidence-view] stream failure", err);
      await recordAuditEvent({
        eventType: "EVIDENCE_VIEWED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { evidenceId: evidence.evidenceId, action: "view", reason: "storage retrieval failed" },
      });
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Evidence could not be retrieved from secure storage." } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
