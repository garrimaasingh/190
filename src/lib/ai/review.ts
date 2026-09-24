import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { appendAuditEvent } from "@/lib/audit/service";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import { computeCaseAccess } from "@/lib/cases/access";
import { documentViewClearance } from "@/lib/documents/authorization";
import { DOCUMENT_CLASSIFICATION_LEVEL, DOCUMENT_TYPES } from "@/lib/constants";

// ============================================================
// AIReviewService (spec §30/§45).
//
// HUMAN REVIEW of AI results — the gate between AI-DERIVED data
// and anything operationally trusted. Invariants:
//  - Reviewer identity ALWAYS comes from the authenticated session
//    (ctx.officer) — client-supplied reviewer ids are structurally
//    impossible here (spec §30).
//  - Reviewing requires AI_REVIEW permission AND case access AND
//    document clearance for the result's source document.
//  - Every action creates an AIReview row + an immutable audit
//    event (AI_RESULT_VERIFIED / REJECTED / OVERRIDDEN).
//  - Review actions NEVER mutate authoritative records: accepting
//    a classification suggestion records the decision on the
//    suggestion row only; the authoritative documentType is
//    untouched (Phase 3 has no mutation API — by design).
// ============================================================

const REVIEWABLE = [
  "CLASSIFICATION",
  "ENTITY",
  "SUMMARY",
  "TIMELINE",
  "RELATIONSHIP",
  "ENTITY_MATCH",
  "TIMELINE_CONFLICT",
] as const;
export type ReviewableType = (typeof REVIEWABLE)[number];

export interface ReviewAction {
  resultType: ReviewableType;
  resultId: string; // internal row id
  action: "VERIFIED" | "REJECTED" | "OVERRIDDEN";
  comment?: string;
  overrideType?: string; // classification override target type
}

interface ResultRef {
  caseRef: string;
  documentRef: string | null;
  reviewStatus: string;
  displayRef: string;
}

async function loadResult(ref: ReviewAction): Promise<{ row: Record<string, unknown> & { id: string }; meta: ResultRef } | null> {
  switch (ref.resultType) {
    case "CLASSIFICATION": {
      const row = await db.aIDocumentClassification.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return {
        row,
        meta: { caseRef: row.caseRef, documentRef: (await docRefOf(row.documentId)), reviewStatus: row.reviewStatus, displayRef: row.id },
      };
    }
    case "ENTITY": {
      const row = await db.extractedEntity.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return {
        row,
        meta: { caseRef: row.caseRef, documentRef: (await docRefOf(row.documentId)), reviewStatus: row.reviewStatus, displayRef: row.id },
      };
    }
    case "SUMMARY": {
      const row = await db.aIDocumentSummary.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return {
        row,
        meta: { caseRef: row.caseRef, documentRef: (await docRefOf(row.documentId)), reviewStatus: row.reviewStatus, displayRef: row.id },
      };
    }
    case "TIMELINE": {
      const row = await db.aITimelineEvent.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return {
        row,
        meta: { caseRef: row.caseRef, documentRef: row.documentRef, reviewStatus: row.reviewStatus, displayRef: row.id },
      };
    }
    case "RELATIONSHIP": {
      const row = await db.aIRelationshipSuggestion.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return { row, meta: { caseRef: row.caseRef, documentRef: row.sourceDocumentRef, reviewStatus: row.status, displayRef: row.id } };
    }
    case "ENTITY_MATCH": {
      const row = await db.entityCandidateMatch.findUnique({ where: { id: ref.resultId }, include: { entityA: { select: { caseRef: true, documentId: true } } } });
      if (!row) return null;
      return {
        row,
        meta: {
          caseRef: row.entityA.caseRef,
          documentRef: await docRefOf(row.entityA.documentId),
          reviewStatus: row.status,
          displayRef: row.id,
        },
      };
    }
    case "TIMELINE_CONFLICT": {
      const row = await db.aITimelineConflict.findUnique({ where: { id: ref.resultId } });
      if (!row) return null;
      return { row, meta: { caseRef: row.caseRef, documentRef: null, reviewStatus: row.status, displayRef: row.id } };
    }
    default:
      return null;
  }
}

async function docRefOf(internalId: string | null): Promise<string | null> {
  if (!internalId) return null;
  const doc = await db.caseDocument.findUnique({ where: { id: internalId }, select: { documentId: true } });
  return doc?.documentId ?? null;
}

async function assertReviewerAuthority(ctx: AuthContext, caseRef: string, documentRef: string | null): Promise<void> {
  if (!roleHas(ctx.officer.role, PERMISSIONS.AI_REVIEW)) {
    throw new ApiError(403, "AI_REVIEW_NOT_ALLOWED", "Your role is not authorized to review AI results.");
  }
  const caseRow = await db.case.findFirst({
    where: { OR: [{ caseId: caseRef }, { id: caseRef }] },
    include: {
      departments: true,
      officers: { where: { status: "ACTIVE" } },
      transfers: { where: { status: "REQUESTED" }, select: { toDepartmentId: true } },
    },
  });
  if (!caseRow) throw new ApiError(404, "CASE_NOT_FOUND", "The result's case no longer exists.");
  const access = computeCaseAccess(ctx, caseRow);
  if (!access.view) {
    throw new ApiError(403, "AI_ACCESS_DENIED", "You are not authorized to review results on this case.");
  }
  if (documentRef) {
    const doc = await db.caseDocument.findUnique({ where: { documentId: documentRef }, select: { classification: true, status: true } });
    if (doc) {
      const level = DOCUMENT_CLASSIFICATION_LEVEL[doc.classification] ?? 99;
      const clearance = documentViewClearance(ctx, access);
      if (level > clearance) {
        throw new ApiError(403, "AI_ACCESS_DENIED", "Your clearance does not cover the classification of this result's source document.");
      }
    }
  }
}

const STATUS_FIELD_BY_TYPE: Record<ReviewableType, string> = {
  CLASSIFICATION: "reviewStatus",
  ENTITY: "reviewStatus",
  SUMMARY: "reviewStatus",
  TIMELINE: "reviewStatus",
  RELATIONSHIP: "status",
  ENTITY_MATCH: "status",
  TIMELINE_CONFLICT: "status",
};

export async function reviewAIResult(ctx: AuthContext, action: ReviewAction) {
  const loaded = await loadResult(action);
  if (!loaded) throw new ApiError(404, "AI_NOT_FOUND", "AI result not found.");
  const { row, meta } = loaded;

  // Already-decided results require no further action (audit trail
  // preserved; corrections are new events, not rewrites).
  const decided = ["VERIFIED", "ACCEPTED", "REJECTED", "OVERRIDDEN", "CONFIRMED", "RESOLVED", "DISMISSED"];
  if (decided.includes(meta.reviewStatus)) {
    throw new ApiError(409, "AI_REVIEW_ALREADY_DECIDED", `This result has already been decided (${meta.reviewStatus}).`);
  }

  await assertReviewerAuthority(ctx, meta.caseRef, meta.documentRef);

  let overrideType: string | null = null;
  if (action.resultType === "CLASSIFICATION" && action.action === "OVERRIDDEN") {
    if (!action.overrideType || !(DOCUMENT_TYPES as readonly string[]).includes(action.overrideType)) {
      throw new ApiError(422, "VALIDATION_ERROR", "An override requires a valid target document type.");
    }
    overrideType = action.overrideType;
  }

  const now = new Date();
  const auditType = action.action === "VERIFIED" ? "AI_RESULT_VERIFIED" : action.action === "REJECTED" ? "AI_RESULT_REJECTED" : "AI_RESULT_OVERRIDDEN";

  switch (action.resultType) {
    case "CLASSIFICATION":
      await db.aIDocumentClassification.update({
        where: { id: action.resultId },
        data: {
          reviewStatus: action.action === "VERIFIED" ? "ACCEPTED" : action.action,
          overrideType,
          reviewedByOfficerId: ctx.officer.id, // SESSION-DERIVED — never client input
          reviewedAt: now,
        },
      });
      break;
    case "ENTITY":
      await db.extractedEntity.update({
        where: { id: action.resultId },
        data: { reviewStatus: action.action, reviewedByOfficerId: ctx.officer.id, reviewedAt: now },
      });
      break;
    case "SUMMARY":
      await db.aIDocumentSummary.update({
        where: { id: action.resultId },
        data: { reviewStatus: action.action },
      });
      break;
    case "TIMELINE":
      await db.aITimelineEvent.update({
        where: { id: action.resultId },
        data: { reviewStatus: action.action },
      });
      break;
    case "RELATIONSHIP":
      await db.aIRelationshipSuggestion.update({
        where: { id: action.resultId },
        data: {
          status: action.action === "VERIFIED" ? "CONFIRMED" : action.action === "REJECTED" ? "REJECTED" : "SUGGESTED",
          reviewedByOfficerId: ctx.officer.id,
          reviewedAt: now,
        },
      });
      break;
    case "ENTITY_MATCH":
      await db.entityCandidateMatch.update({
        where: { id: action.resultId },
        data: {
          status: action.action === "VERIFIED" ? "CONFIRMED" : action.action === "REJECTED" ? "REJECTED" : "SUGGESTED",
          reviewedByOfficerId: ctx.officer.id,
          reviewedAt: now,
        },
      });
      break;
    case "TIMELINE_CONFLICT":
      await db.aITimelineConflict.update({
        where: { id: action.resultId },
        data: {
          status: action.action === "VERIFIED" ? "RESOLVED" : action.action === "REJECTED" ? "DISMISSED" : "UNREVIEWED",
          resolvedByOfficerId: ctx.officer.id,
          resolutionNote: action.comment ?? null,
          resolvedAt: now,
        },
      });
      break;
  }

  await db.aIReview.create({
    data: {
      resultType: action.resultType,
      resultId: action.resultId,
      resultRef: meta.displayRef,
      reviewerOfficerId: ctx.officer.id, // session-derived
      reviewerDepartmentId: ctx.officer.departmentId,
      status: action.action,
      comment: action.comment?.slice(0, 1000) ?? null,
    },
  });

  await appendAuditEvent({
    eventType: auditType,
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: meta.caseRef,
    documentId: meta.documentRef,
    sessionId: ctx.sessionId,
    metadata: {
      resultType: action.resultType,
      resultRef: meta.displayRef,
      action: action.action,
      overrideType,
    },
  });

  return { ok: true, statusField: STATUS_FIELD_BY_TYPE[action.resultType] };
}
