import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { assertCaseView, assertCaseManage, type CaseAccess } from "@/lib/cases/access";
import { canViewDocument } from "@/lib/documents/authorization";
import { recordDocumentEvent } from "@/lib/documents/events";

// ============================================================
// Route-level document loading & authorization guards.
//
// 404 is returned when the document does not exist OR does not
// belong to the case in the URL (wrong case/document combination,
// spec §78) — existence is never leaked across case boundaries.
// Denied views produce a DOCUMENT_ACCESS_DENIED audit event
// (spec §24/§51) without disclosing classification details.
// ============================================================

export interface LoadedDocument {
  caseRow: { id: string; caseId: string; status: string };
  access: CaseAccess;
  doc: {
    id: string;
    documentId: string;
    caseId: string;
    title: string;
    status: string;
    classification: string;
    storageKey: string;
    mimeType: string;
    originalFilename: string;
    fileSize: number;
    sha256Hash: string;
  };
}

export async function loadDocumentForView(
  ctx: AuthContext,
  caseRef: string,
  documentRef: string
): Promise<LoadedDocument> {
  const { caseRow, access } = await assertCaseView(ctx, caseRef);

  const doc = await db.caseDocument.findFirst({
    where: { OR: [{ documentId: documentRef }, { id: documentRef }], caseId: caseRow.id },
    select: {
      id: true,
      documentId: true,
      caseId: true,
      title: true,
      status: true,
      classification: true,
      storageKey: true,
      mimeType: true,
      originalFilename: true,
      fileSize: true,
      sha256Hash: true,
    },
  });
  if (!doc) {
    // Wrong case/document combination or nonexistent document (spec §78)
    throw new ApiError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Document not found in this case.");
  }
  return { caseRow, access, doc };
}

export async function assertDocumentViewable(
  ctx: AuthContext,
  caseRef: string,
  documentRef: string,
  action: "view" | "download" | "verify"
): Promise<LoadedDocument> {
  const loaded = await loadDocumentForView(ctx, caseRef, documentRef);
  const { caseRow, doc, access } = loaded;
  if (!canViewDocument(ctx, access, doc.classification, doc.status)) {
    await recordDocumentEvent({
      eventType: "DOCUMENT_ACCESS_DENIED",
      caseId: caseRow.id,
      documentId: doc.id,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { documentId: doc.documentId, action },
    });
    throw new ApiError(403, ERROR_CODES.DOCUMENT_ACCESS_DENIED, "You are not authorized to access this document.");
  }
  return loaded;
}

export async function assertDocumentManager(ctx: AuthContext, caseRef: string) {
  return assertCaseManage(ctx, caseRef);
}
