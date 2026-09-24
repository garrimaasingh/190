import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import type { CaseAccess } from "@/lib/cases/access";
import type { CaseEventType } from "@/lib/constants";
import { DOCUMENT_CLASSIFICATION_LEVEL } from "@/lib/constants";
import { validateUploadedFile } from "@/lib/documents/validation";
import { scanFileContent } from "@/lib/documents/scanner";
import { calculateSha256, verifyHash } from "@/lib/documents/integrity";
import { encryptDocument, decryptDocument } from "@/lib/documents/encryption";
import { DocumentStorage, buildStorageKey } from "@/lib/documents/storage";
import { recordDocumentEvent } from "@/lib/documents/events";
import { documentViewClearance } from "@/lib/documents/authorization";

// ============================================================
// DocumentService (spec §11/§12/§22/§23/§37-§40/§67-§69).
//
// The ONLY writer of CaseDocument rows. Uploads follow the staged
// pipeline: session → validate → scan → hash → encrypt → store →
// commit (single DB transaction) → events. A document row is
// created exclusively at commit time, so a failed upload can never
// surface as a valid legal document. Storage and database are two
// systems: failures after object storage trigger best-effort
// orphan cleanup and leave a reconcilable session record (spec §23).
// ============================================================

export interface DocumentUploadInput {
  title: string;
  description?: string | null;
  documentType: string;
  documentCategory?: string | null;
  classification: string;
  documentDate?: Date | null;
  referenceNumber?: string | null;
  issuingDepartmentName?: string | null;
  externalReference?: string | null;
  tags?: string[];
  clientRequestId?: string | null;
}

export interface DocumentUploadFiles {
  buffer: Buffer;
  originalFilename: string;
  declaredMimeType: string | null | undefined;
}

interface CaseRowMinimal {
  id: string;
  caseId: string;
  status: string;
}

export interface DocumentSummaryRow {
  id: string; // internal id (needed by services; not exposed to clients)
  documentId: string;
  title: string;
  description: string | null;
  documentType: string;
  documentCategory: string | null;
  classification: string;
  status: string;
  originalFilename: string;
  mimeType: string;
  fileExtension: string;
  fileSize: number;
  sha256Hash: string;
  encryptionStatus: string;
  documentDate: Date | null;
  createdAt: Date;
  committedAt: Date | null;
  supersededByDocumentId: string | null;
  metadata: string | null;
  uploadedByOfficer: { officerId: string; name: string } | null;
  uploadedByDepartment: { id: string; departmentCode: string; name: string; departmentType: string } | null;
}

const SUMMARY_SELECT = {
  id: true,
  documentId: true,
  title: true,
  description: true,
  documentType: true,
  documentCategory: true,
  classification: true,
  status: true,
  originalFilename: true,
  mimeType: true,
  fileExtension: true,
  fileSize: true,
  sha256Hash: true,
  encryptionStatus: true,
  documentDate: true,
  createdAt: true,
  committedAt: true,
  supersededByDocumentId: true,
  metadata: true,
  uploadedByOfficer: { select: { officerId: true, name: true } },
  uploadedByDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
} as const;

/** API-facing projection — storage keys, key references and internal ids NEVER leave the server (spec §30). */
export function toDocumentSummary(doc: DocumentSummaryRow, casePublicId: string) {
  const { id, ...rest } = doc;
  void id;
  return {
    id: rest.documentId,
    caseId: casePublicId,
    title: rest.title,
    description: rest.description,
    documentType: rest.documentType,
    documentCategory: rest.documentCategory,
    classification: rest.classification,
    status: rest.status,
    originalFilename: rest.originalFilename,
    mimeType: rest.mimeType,
    fileExtension: rest.fileExtension,
    fileSize: rest.fileSize,
    sha256Hash: rest.sha256Hash,
    encryptionStatus: rest.encryptionStatus,
    documentDate: rest.documentDate,
    uploadedAt: rest.createdAt,
    committedAt: rest.committedAt,
    supersededByDocumentId: rest.supersededByDocumentId,
    uploadedBy: rest.uploadedByOfficer,
    department: rest.uploadedByDepartment,
    metadata: rest.metadata ? (JSON.parse(rest.metadata) as Record<string, unknown>) : null,
  };
}

function serializeMetadata(input: DocumentUploadInput): string | null {
  const hasAny =
    input.referenceNumber ||
    input.issuingDepartmentName ||
    input.externalReference ||
    (input.tags && input.tags.length > 0);
  if (!hasAny) return null;
  return JSON.stringify({
    ...(input.referenceNumber ? { referenceNumber: input.referenceNumber } : {}),
    ...(input.issuingDepartmentName ? { issuingDepartmentName: input.issuingDepartmentName } : {}),
    ...(input.externalReference ? { externalReference: input.externalReference } : {}),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
  });
}

// ------------------------------------------------------------
// Idempotency (spec §68): a retried request never double-commits.
// ------------------------------------------------------------
async function resolveIdempotency(ctx: AuthContext, caseId: string, clientRequestId: string | null | undefined) {
  if (!clientRequestId) return null;
  const existing = await db.documentUploadSession.findUnique({
    where: { uploadedByOfficerId_clientRequestId: { uploadedByOfficerId: ctx.officer.id, clientRequestId } },
  });
  if (!existing || existing.caseId !== caseId) return null;
  if (existing.status === "COMMITTED" && existing.createdDocumentId) {
    const doc = await db.caseDocument.findFirst({
      where: { documentId: existing.createdDocumentId },
      select: SUMMARY_SELECT,
    });
    if (doc) return { replayed: true as const, document: doc as DocumentSummaryRow };
  }
  if (["UPLOADING", "VALIDATING", "STORING", "COMMITTING"].includes(existing.status)) {
    throw new ApiError(409, "UPLOAD_DUPLICATE_IN_PROGRESS", "An upload with this request id is already in progress.");
  }
  // FAILED / QUARANTINED / DISCARDED: release the key so a retry can proceed.
  await db.documentUploadSession
    .update({ where: { id: existing.id }, data: { clientRequestId: null } })
    .catch(() => undefined);
  return null;
}

export interface UploadOutcome {
  document: DocumentSummaryRow;
  quarantined: boolean;
  duplicateWarning: string | null;
  replayed: boolean;
}

// ------------------------------------------------------------
// Staged upload pipeline (spec §11/§12/§22/§69)
// ------------------------------------------------------------
export async function uploadAndCommit(params: {
  ctx: AuthContext;
  caseRow: CaseRowMinimal;
  input: DocumentUploadInput;
  file: DocumentUploadFiles;
}): Promise<UploadOutcome> {
  const { ctx, caseRow, input, file } = params;

  const replay = await resolveIdempotency(ctx, caseRow.id, input.clientRequestId);
  if (replay) {
    return {
      document: replay.document,
      quarantined: replay.document.status === "QUARANTINED",
      duplicateWarning: null,
      replayed: true,
    };
  }

  const actor = {
    actorOfficerId: ctx.officer.id,
    actorIdentifier: ctx.officer.officerId,
    departmentId: ctx.officer.departmentId,
    sessionId: ctx.sessionId,
  };

  // Stage 1 — UPLOADING: open the session record (reconciliation anchor)
  const session = await db.documentUploadSession.create({
    data: {
      caseId: caseRow.id,
      clientRequestId: input.clientRequestId || null,
      status: "UPLOADING",
      originalFilename: file.originalFilename.slice(0, 200),
      declaredMimeType: file.declaredMimeType || null,
      fileSize: file.buffer.length,
      uploadedByOfficerId: ctx.officer.id,
    },
  });
  await recordDocumentEvent(
    {
      eventType: "DOCUMENT_UPLOAD_STARTED",
      caseId: caseRow.id,
            ...actor,
      metadata: {
        filename: file.originalFilename.slice(0, 200),
        size: file.buffer.length,
        clientRequestId: input.clientRequestId ?? null,
      },
    },
    db
  );

  const failSession = async (status: "FAILED" | "QUARANTINED" | "DISCARDED", message: string, storageKey?: string | null) => {
    await db.documentUploadSession
      .update({ where: { id: session.id }, data: { status, errorMessage: message.slice(0, 500), ...(storageKey !== undefined ? { storageKey } : {}) } })
      .catch(() => undefined);
  };

  try {
    // Stage 2 — VALIDATING (spec §13/§14): extension, declared MIME, magic bytes, size, empty
    let validated;
    try {
      await db.documentUploadSession.update({ where: { id: session.id }, data: { status: "VALIDATING" } });
      await recordDocumentEvent(
        { eventType: "DOCUMENT_VALIDATION_STARTED", caseId: caseRow.id, ...actor },
        db
      );
      validated = validateUploadedFile({
        originalFilename: file.originalFilename,
        declaredMimeType: file.declaredMimeType,
        buffer: file.buffer,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "File validation failed.";
      await failSession("DISCARDED", message);
      await recordDocumentEvent(
        {
          eventType: "DOCUMENT_VALIDATION_FAILED",
          caseId: caseRow.id,
          result: "FAILED",
          ...actor,
          metadata: { reason: message.slice(0, 200) },
        },
        db
      );
      throw err;
    }

    // Security scan (spec §45): MALICIOUS discards, SUSPICIOUS quarantines the record.
    const scan = scanFileContent(file.buffer, validated.mimeType);
    if (scan.verdict === "MALICIOUS") {
      const message = scan.reason || "File rejected by security scan.";
      await failSession("FAILED", message);
      await recordDocumentEvent(
        {
          eventType: "DOCUMENT_VALIDATION_FAILED",
          caseId: caseRow.id,
          result: "FAILED",
          ...actor,
          metadata: { reason: message.slice(0, 200), scanner: scan.scanner },
        },
        db
      );
      throw new ApiError(422, "FILE_SCAN_FAILED", "The file was rejected by the security scanner.");
    }
    const quarantine = scan.verdict === "SUSPICIOUS";

    // SHA-256 integrity fingerprint over PLAINTEXT, pre-encryption (spec §20)
    let sha256Hash: string;
    try {
      sha256Hash = calculateSha256(file.buffer);
    } catch (err) {
      await failSession("FAILED", "Hash calculation failed.");
      console.error("[document-service] hash failure", err);
      throw new ApiError(500, "INTERNAL_ERROR", "Integrity fingerprint could not be calculated.");
    }

    // Duplicate awareness (spec §66/§67): hash is NOT a business identifier —
    // identical content within the case yields a warning, never a block.
    const duplicate = await db.caseDocument.findFirst({
      where: { caseId: caseRow.id, sha256Hash, status: { in: ["COMMITTED", "SUPERSEDED"] } },
      select: { documentId: true },
    });

    // Encrypt (spec §18) then store (spec §15/§16) — object first, metadata second
    await db.documentUploadSession.update({ where: { id: session.id }, data: { status: "STORING" } });
    const { blob, keyReference } = encryptDocument(file.buffer);
    const documentUuid = randomUUID();
    const storageKey = buildStorageKey(caseRow.id, documentUuid);
    const storedFilename = `${documentUuid}.bin`;
    try {
      DocumentStorage.ensureRoot();
      await DocumentStorage.put_object(storageKey, blob);
    } catch (err) {
      await failSession("FAILED", "Secure storage temporarily unavailable.", storageKey);
      console.error("[document-service] storage failure", err);
      throw new ApiError(503, "INTERNAL_ERROR", "Secure storage is temporarily unavailable. The upload was not committed.");
    }

    // Stage 3 — COMMIT: document row + events + session completion in ONE transaction (spec §22/§23)
    await db.documentUploadSession.update({ where: { id: session.id }, data: { status: "COMMITTING" } });
    let committed;
    try {
      committed = await db.$transaction(async (tx) => {
        const { generateDocumentId } = await import("@/lib/cases/ids");
        const geo = await tx.case.findUniqueOrThrow({
          where: { id: caseRow.id },
          select: { state: { select: { code: true } }, district: { select: { code: true } } },
        });
        const publicId = await generateDocumentId(
          { state: { code: geo.state.code }, district: { code: geo.district.code } },
          new Date().getFullYear()
        );

        const doc = await tx.caseDocument.create({
          data: {
            documentId: publicId,
            caseId: caseRow.id,
            title: input.title,
            description: input.description || null,
            documentType: input.documentType,
            documentCategory: input.documentCategory || null,
            originalFilename: validated.originalFilename,
            storedFilename,
            mimeType: validated.mimeType,
            fileExtension: validated.fileExtension,
            fileSize: validated.fileSize,
            storageProvider: DocumentStorage.provider,
            storageKey,
            sha256Hash,
            encryptionStatus: "ENCRYPTED_AES_256_GCM",
            keyReference,
            status: quarantine ? "QUARANTINED" : "COMMITTED",
            classification: input.classification,
            uploadedByOfficerId: ctx.officer.id,
            uploadedByDepartmentId: ctx.officer.departmentId,
            documentDate: input.documentDate || null,
            metadata: serializeMetadata(input),
            committedAt: quarantine ? null : new Date(),
            uploadSessionId: session.id,
          },
          select: SUMMARY_SELECT,
        });

        await recordDocumentEvent(
          {
            eventType: quarantine ? "DOCUMENT_VALIDATION_FAILED" : "DOCUMENT_COMMITTED",
            caseId: caseRow.id,
            documentId: doc.id,
            result: quarantine ? "QUARANTINED" : "SUCCESS",
            ...actor,
            metadata: {
              documentId: doc.documentId,
              sha256: sha256Hash,
              classification: input.classification,
              ...(quarantine ? { scanner: scan.scanner, reason: scan.reason } : {}),
            },
            caseEventType: quarantine ? null : "DOCUMENT_COMMITTED",
            caseDescription: `Document committed: ${doc.title} (${doc.documentId})`,
          },
          tx
        );

        await tx.documentUploadSession.update({
          where: { id: session.id },
          data: { status: quarantine ? "QUARANTINED" : "COMMITTED", createdDocumentId: doc.documentId, storageKey },
        });

        return doc as DocumentSummaryRow;
      });
    } catch (err) {
      // Metadata persistence failed AFTER object storage (spec §22/§23):
      // clean up the orphaned object and leave a reconcilable FAILED session.
      DocumentStorage.delete_staged_object(storageKey);
      await failSession("FAILED", "Metadata commit failed; staged object cleaned up.", null);
      console.error("[document-service] commit failure — orphan cleanup executed", err);
      throw new ApiError(500, "INTERNAL_ERROR", "Document commit failed. The upload was not recorded.");
    }

    return {
      document: committed,
      quarantined: committed.status === "QUARANTINED",
      duplicateWarning: duplicate && !quarantine ? duplicate.documentId : null,
      replayed: false,
    };
  } catch (err) {
    throw err;
  }
}

// ------------------------------------------------------------
// Related-document workflows (spec §37/§38/§39)
// ------------------------------------------------------------
export const RELATED_WORKFLOW_TYPES = ["SUPPLEMENT", "CORRECTION", "REPLACEMENT"] as const;
export type RelatedWorkflowType = (typeof RELATED_WORKFLOW_TYPES)[number];

export async function createRelatedDocument(params: {
  ctx: AuthContext;
  caseRow: CaseRowMinimal;
  target: { id: string; documentId: string; title: string; status: string };
  workflow: RelatedWorkflowType;
  input: DocumentUploadInput;
  file: DocumentUploadFiles;
}): Promise<{ document: DocumentSummaryRow; relationshipType: RelatedWorkflowType; supersededTarget: boolean; duplicateWarning: string | null }> {
  const { ctx, caseRow, target, workflow, input, file } = params;

  // Target eligibility (spec §37-§39): operate only on committed records;
  // a SUPERSEDED document already has a designated successor.
  if (target.status !== "COMMITTED" && !(workflow !== "REPLACEMENT" && target.status === "SUPERSEDED")) {
    throw new ApiError(409, "INVALID_DOCUMENT_STATE", "Related documents can only be created from committed records.");
  }

  const upload = await uploadAndCommit({ ctx, caseRow, input, file });
  if (upload.quarantined) {
    throw new ApiError(422, "FILE_SCAN_FAILED", "The uploaded file was quarantined; no relationship was created.");
  }

  const actor = {
    actorOfficerId: ctx.officer.id,
    actorIdentifier: ctx.officer.officerId,
    departmentId: ctx.officer.departmentId,
    sessionId: ctx.sessionId,
  };

  const eventType: CaseEventType =
    workflow === "SUPPLEMENT" ? "DOCUMENT_SUPPLEMENT_CREATED"
    : workflow === "CORRECTION" ? "DOCUMENT_CORRECTION_CREATED"
    : "DOCUMENT_REPLACEMENT_CREATED";

  let supersededTarget = false;
  await db.$transaction(async (tx) => {
    const relationship = await tx.documentRelationship.create({
      data: {
        sourceDocumentId: upload.document.id, // the NEW document (internal id)
        targetDocumentId: target.id, // the ORIGINAL (internal id)
        relationshipType: workflow,
        createdByOfficerId: ctx.officer.id,
      },
    });
    void relationship;

    if (workflow === "REPLACEMENT") {
      await tx.caseDocument.update({
        where: { id: target.id, status: "COMMITTED" },
        data: { status: "SUPERSEDED", supersededByDocumentId: upload.document.documentId },
      });
      supersededTarget = true;
      await recordDocumentEvent(
        {
          eventType: "DOCUMENT_SUPERSEDED",
          caseId: caseRow.id,
          documentId: target.id,
          result: "SUCCESS",
          ...actor,
          metadata: { documentId: target.documentId, supersededBy: upload.document.documentId },
          caseEventType: "DOCUMENT_SUPERSEDED",
          caseDescription: `Document ${target.documentId} superseded by ${upload.document.documentId}`,
        },
        tx
      );
    }

    await recordDocumentEvent(
      {
        eventType,
        caseId: caseRow.id,
        documentId: upload.document.id,
        result: "SUCCESS",
        ...actor,
        metadata: { documentId: upload.document.documentId, relatedTo: target.documentId, relationshipType: workflow },
        caseEventType: eventType,
        caseDescription: `${workflow.charAt(0)}${workflow.slice(1).toLowerCase()} document ${upload.document.documentId} created for ${target.documentId}`,
      },
      tx
    );
  });

  return {
    document: upload.document,
    relationshipType: workflow,
    supersededTarget,
    duplicateWarning: upload.duplicateWarning,
  };
}

// ------------------------------------------------------------
// RELATED / REFERENCE links between existing documents (spec §9/§79)
// ------------------------------------------------------------
export async function linkDocuments(params: {
  ctx: AuthContext;
  access: CaseAccess;
  caseId: string;
  source: { id: string; documentId: string; classification: string };
  target: { id: string; documentId: string; classification: string };
  relationshipType: "RELATED" | "REFERENCE";
}): Promise<{ relationshipId: string }> {
  const { ctx, source, target, relationshipType, caseId } = params;

  if (source.id === target.id) {
    throw new ApiError(422, "INVALID_RELATIONSHIP", "A document cannot relate to itself.");
  }
  // The actor must be able to view BOTH endpoints.
  const clearance = documentViewClearance(ctx, params.access);
  for (const endpoint of [source, target]) {
    if (endpoint.classification && clearance < classificationLevel(endpoint.classification)) {
      throw new ApiError(403, "DOCUMENT_ACCESS_DENIED", "You are not authorized to link one of these documents.");
    }
  }
  const dup = await db.documentRelationship.findFirst({
    where: { sourceDocumentId: source.id, targetDocumentId: target.id, relationshipType },
    select: { id: true },
  });
  if (dup) {
    throw new ApiError(409, "INVALID_RELATIONSHIP", "This relationship already exists.");
  }

  const relationship = await db.documentRelationship.create({
    data: {
      sourceDocumentId: source.id,
      targetDocumentId: target.id,
      relationshipType,
      createdByOfficerId: ctx.officer.id,
    },
  });

  await recordDocumentEvent(
    {
      eventType: "DOCUMENT_RELATIONSHIP_CREATED",
      caseId,
      documentId: source.id,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "SUCCESS",
      metadata: { documentId: source.documentId, relatedTo: target.documentId, relationshipType },
    },
    db
  );
  return { relationshipId: relationship.id };
}

function classificationLevel(classification: string): number {
  const level = DOCUMENT_CLASSIFICATION_LEVEL[classification];
  return level === undefined ? 99 : level;
}

// ------------------------------------------------------------
// Controlled integrity verification (spec §21) — backend process,
// SYSTEM_ADMIN only at the route layer. NOT a user-facing
// "tampered" badge: immutability is enforced by the authorization
// model, this is an audit/reconciliation tool.
// ------------------------------------------------------------
export async function verifyDocumentIntegrity(params: {
  ctx: AuthContext;
  document: { id: string; documentId: string; caseId: string; casePublicId: string; storageKey: string; sha256Hash: string };
}): Promise<{ match: boolean; recordedHash: string; computedHash: string }> {
  const { ctx, document } = params;
  let result: { match: boolean; recordedHash: string; computedHash: string };
  try {
    const stored = await DocumentStorage.get_object(document.storageKey);
    const plaintext = decryptDocument(stored);
    result = verifyHash(plaintext, document.sha256Hash);
  } catch (err) {
    console.error("[document-integrity] verification error", document.documentId, err);
    result = { match: false, recordedHash: document.sha256Hash, computedHash: "VERIFICATION_ERROR" };
  }
  await recordDocumentEvent(
    {
      eventType: "DOCUMENT_INTEGRITY_VERIFIED",
      caseId: document.caseId,
      documentId: document.id,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      departmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: result.match ? "MATCH" : "MISMATCH",
      metadata: { documentId: document.documentId },
    },
    db
  );
  return result;
}
