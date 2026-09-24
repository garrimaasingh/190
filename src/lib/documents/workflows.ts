import { ApiError } from "@/lib/api";
import { jsonOk } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { assertCaseManage } from "@/lib/cases/access";
import { PERMISSIONS, roleHas } from "@/lib/permissions";
import { documentUploadSchema } from "@/lib/validation";
import { canCreateRelated } from "@/lib/documents/authorization";
import { createRelatedDocument, toDocumentSummary, type RelatedWorkflowType, type DocumentUploadInput } from "@/lib/documents/service";
import { recordDocumentEvent } from "@/lib/documents/events";

// ============================================================
// Shared implementation for the supplement / correction /
// replacement workflow routes (spec §37/§38/§39).
//
// Authorization = case MANAGE (custodian authority, spec §25/§55) +
// DOCUMENT_UPLOAD permission + case status gate + classification
// ceiling. The original document is NEVER modified: replacement
// flips its STATUS to SUPERSEDED (a state, not a deletion), and
// the new record links back to it via DocumentRelationship.
// ============================================================

const WORKFLOW_FORM_FIELDS = [
  "title",
  "description",
  "documentType",
  "documentCategory",
  "classification",
  "documentDate",
  "referenceNumber",
  "issuingDepartmentName",
  "externalReference",
  "tags",
  "clientRequestId",
] as const;

export async function handleRelatedDocumentUpload(
  req: Request,
  ctx: AuthContext,
  caseRef: string,
  documentRef: string,
  workflow: RelatedWorkflowType
) {
  const { caseRow, access } = await assertCaseManage(ctx, caseRef);

  const target = await db.caseDocument.findFirst({
    where: { OR: [{ documentId: documentRef }, { id: documentRef }], caseId: caseRow.id },
    select: { id: true, documentId: true, title: true, status: true },
  });
  if (!target) {
    throw new ApiError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Document not found in this case.");
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, "multipart/form-data body with a file is required.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApiError(422, ERROR_CODES.INVALID_FILE, "A document file is required.");
  }

  const raw: Record<string, unknown> = {};
  for (const key of WORKFLOW_FORM_FIELDS) {
    const value = form.get(key);
    if (typeof value === "string" && value !== "") {
      if (key === "tags") {
        raw.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      } else if (key === "documentDate") {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
          throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Document date is invalid.");
        }
        raw.documentDate = d;
      } else {
        raw[key] = value;
      }
    }
  }
  // Default title pattern per spec examples (§37/§38): "<Original> — Supplement/Correction/Replacement"
  if (!raw.title) {
    raw.title = `${target.title} — ${workflow.charAt(0)}${workflow.slice(1).toLowerCase()}`.slice(0, 200);
  }
  const input = documentUploadSchema.parse(raw) as DocumentUploadInput;

  const gate = canCreateRelated(ctx, access, caseRow.status, input.classification);
  if (!gate.allowed) {
    await recordDocumentEvent({
      eventType: "DOCUMENT_VALIDATION_FAILED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { reason: gate.reason || "related document creation not permitted" },
    });
    throw new ApiError(403, ERROR_CODES.DOCUMENT_ACCESS_DENIED, gate.reason || "Not permitted.");
  }
  void roleHas;
  void PERMISSIONS;

  const buffer = Buffer.from(await file.arrayBuffer());
  const outcome = await createRelatedDocument({
    ctx,
    caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
    target,
    workflow,
    input,
    file: { buffer, originalFilename: file.name, declaredMimeType: file.type },
  });

  return jsonOk(
    {
      quarantined: false,
      duplicateWarning: outcome.duplicateWarning,
      supersededTarget: outcome.supersededTarget,
      relationshipType: outcome.relationshipType,
      document: toDocumentSummary(outcome.document, caseRow.caseId),
    },
    201
  );
}
