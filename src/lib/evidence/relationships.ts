import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import type { CaseAccess } from "@/lib/cases/access";
import { EVIDENCE_RELATIONSHIP_TYPES } from "@/lib/constants";
import { documentViewClearance } from "@/lib/documents/authorization";
import { DOCUMENT_CLASSIFICATION_LEVEL } from "@/lib/constants";
import { appendAuditEvent } from "@/lib/audit/service";

// ============================================================
// EvidenceRelationshipService (spec §20).
//
// Direction is DOCUMENT → EVIDENCE ("Forensic Report DESCRIBES
// evidence EVD-001"). Both endpoints must belong to the SAME case
// — cross-case links are rejected as 404s that never confirm the
// existence of out-of-case resources. This is deliberately NOT a
// knowledge graph: no inference, no traversal engine (spec §68).
// ============================================================

export interface LinkEvidenceDocumentInput {
  documentId: string; // public DOC id (or internal id, resolved here)
  relationshipType: string;
  note?: string | null;
}

export async function linkEvidenceDocument(params: {
  ctx: AuthContext;
  access: CaseAccess;
  caseRow: { id: string; caseId: string };
  evidence: { id: string; evidenceId: string; classification: string };
  input: LinkEvidenceDocumentInput;
}) {
  const { ctx, access, caseRow, evidence, input } = params;

  if (!EVIDENCE_RELATIONSHIP_TYPES.includes(input.relationshipType as (typeof EVIDENCE_RELATIONSHIP_TYPES)[number])) {
    throw new ApiError(422, "INVALID_RELATIONSHIP", `Relationship type must be one of: ${EVIDENCE_RELATIONSHIP_TYPES.join(", ")}.`);
  }

  // The document must exist IN THIS CASE — cross-case combinations
  // are 404s (existence never leaked across case boundaries).
  const document = await db.caseDocument.findFirst({
    where: { OR: [{ documentId: input.documentId }, { id: input.documentId }], caseId: caseRow.id },
    select: { id: true, documentId: true, classification: true, title: true },
  });
  if (!document) {
    throw new ApiError(404, "DOCUMENT_NOT_FOUND", "Document not found in this case.");
  }

  // The actor must be able to view BOTH endpoints (classification
  // clearance on the document, matching the evidence authorization).
  const clearance = documentViewClearance(ctx, access);
  const docLevel = DOCUMENT_CLASSIFICATION_LEVEL[document.classification] ?? 99;
  if (docLevel > clearance) {
    throw new ApiError(403, "DOCUMENT_ACCESS_DENIED", "You are not authorized to link this document.");
  }
  const evdLevel = DOCUMENT_CLASSIFICATION_LEVEL[evidence.classification] ?? 99;
  if (evdLevel > evidenceClearance(ctx, access)) {
    throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "You are not authorized to link this evidence.");
  }

  const dup = await db.evidenceDocumentRelationship.findFirst({
    where: { evidenceId: evidence.id, documentId: document.id, relationshipType: input.relationshipType },
    select: { id: true },
  });
  if (dup) {
    throw new ApiError(409, "INVALID_RELATIONSHIP", "This relationship already exists.");
  }

  const relationship = await db.$transaction(async (tx) => {
    const created = await tx.evidenceDocumentRelationship.create({
      data: {
        evidenceId: evidence.id,
        documentId: document.id,
        relationshipType: input.relationshipType,
        note: input.note ?? null,
        createdByOfficerId: ctx.officer.id,
      },
    });

    await appendAuditEvent(
      {
        eventType: "EVIDENCE_RELATIONSHIP_CREATED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        documentId: document.documentId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        metadata: { relationshipType: input.relationshipType, documentId: document.documentId, evidenceId: evidence.evidenceId },
      },
      tx
    );

    return created;
  });

  return { relationshipId: relationship.id, relationshipType: input.relationshipType, documentId: document.documentId, evidenceId: evidence.evidenceId };
}

function evidenceClearance(ctx: AuthContext, access: CaseAccess): number {
  // Same model as evidenceViewClearance — inlined to avoid a cycle.
  const role = ctx.officer.role;
  if (role === "SYSTEM_ADMIN") return 4;
  if (role === "AUDITOR") return 3;
  if (access.isCustodianSide) {
    if (role === "DEPARTMENT_ADMIN") return 4;
    if (role === "OFFICER" && access.assigned) return 4;
    return 2;
  }
  if (access.assigned) return 2;
  return 1;
}

export async function listEvidenceRelationships(evidenceInternalId: string) {
  return db.evidenceDocumentRelationship.findMany({
    where: { evidenceId: evidenceInternalId },
    orderBy: { createdAt: "desc" },
    include: {
      document: {
        select: {
          documentId: true,
          title: true,
          documentType: true,
          classification: true,
          status: true,
          sha256Hash: true,
        },
      },
      createdByOfficer: { select: { officerId: true, name: true } },
    },
  });
}
