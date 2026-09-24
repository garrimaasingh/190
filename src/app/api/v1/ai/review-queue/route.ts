import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { AI_REVIEWABLE_RESULT_TYPES, PAGE_SIZES } from "@/lib/constants";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const queueSchema = z.object({
  resultType: z.enum(AI_REVIEWABLE_RESULT_TYPES).optional(),
  status: z.string().optional(),
  caseRef: z.string().optional(),
  model: z.string().optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZES.MAX).default(PAGE_SIZES.DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

interface QueueItem {
  reviewKey: string;
  resultType: string;
  resultId: string;
  caseRef: string;
  documentRef: string | null;
  summary: string;
  confidence: number | null;
  model: { provider: string; modelName: string; modelVersion: string | null };
  reviewStatus: string;
  createdAt: Date;
}

// GET /api/v1/ai/review-queue (spec §45)
// Unified pending-review feed across result types. FILTERED TO THE
// CALLER'S AUTHORIZED SCOPE server-side: only results whose case is
// viewable and whose source document's classification is within the
// caller's clearance are returned.
export async function GET(req: Request) {
  try {
    const { ctx } = await requireAIAccess(req);
    const url = new URL(req.url);
    const q = queueSchema.parse(Object.fromEntries(url.searchParams));

    const scope = await buildAuthorizedScope(ctx);
    const authorizedRefs = new Set(scope.keys());

    const items: QueueItem[] = [];
    const wants = (t: string) => !q.resultType || q.resultType === t;
    const inScope = (caseRef: string) => authorizedRefs.has(caseRef);

    if (wants("CLASSIFICATION")) {
      const rows = await db.aIDocumentClassification.findMany({
        where: { reviewStatus: "PENDING", ...(q.caseRef ? { caseRef: q.caseRef } : {}) },
        include: { document: { select: { documentId: true, title: true, classification: true } } },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.caseRef)) continue;
        if (q.model && !`${r.modelProvider}/${r.modelName}`.includes(q.model)) continue;
        if (q.minConfidence !== undefined && r.confidence < q.minConfidence) continue;
        if (q.maxConfidence !== undefined && r.confidence > q.maxConfidence) continue;
        items.push({
          reviewKey: "CLASSIFICATION",
          resultType: "CLASSIFICATION",
          resultId: r.id,
          caseRef: r.caseRef,
          documentRef: r.document.documentId,
          summary: `Suggested type ${r.suggestedType} for "${r.document.title}"`,
          confidence: r.confidence,
          model: { provider: r.modelProvider, modelName: r.modelName, modelVersion: r.modelVersion },
          reviewStatus: r.reviewStatus,
          createdAt: r.createdAt,
        });
      }
    }
    if (wants("ENTITY")) {
      const rows = await db.extractedEntity.findMany({
        where: { reviewStatus: "PENDING", ...(q.caseRef ? { caseRef: q.caseRef } : {}) },
        include: { document: { select: { documentId: true, title: true, classification: true } } },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.caseRef)) continue;
        if (q.model && !`${r.modelProvider}/${r.modelName}`.includes(q.model)) continue;
        if (q.minConfidence !== undefined && r.confidence < q.minConfidence) continue;
        if (q.maxConfidence !== undefined && r.confidence > q.maxConfidence) continue;
        items.push({
          reviewKey: "ENTITY",
          resultType: "ENTITY",
          resultId: r.id,
          caseRef: r.caseRef,
          documentRef: r.document.documentId,
          summary: `${r.entityType}: "${r.originalText}" (page ${r.pageNumber}) of "${r.document.title}"`,
          confidence: r.confidence,
          model: { provider: r.modelProvider, modelName: r.modelName, modelVersion: r.modelVersion },
          reviewStatus: r.reviewStatus,
          createdAt: r.createdAt,
        });
      }
    }
    if (wants("TIMELINE")) {
      const rows = await db.aITimelineEvent.findMany({
        where: { reviewStatus: "PENDING", ...(q.caseRef ? { caseRef: q.caseRef } : {}) },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.caseRef)) continue;
        if (q.model && !`${r.modelProvider}/${r.modelName}`.includes(q.model)) continue;
        if (q.minConfidence !== undefined && r.confidence < q.minConfidence) continue;
        if (q.maxConfidence !== undefined && r.confidence > q.maxConfidence) continue;
        items.push({
          reviewKey: "TIMELINE",
          resultType: "TIMELINE",
          resultId: r.id,
          caseRef: r.caseRef,
          documentRef: r.documentRef,
          summary: `${r.eventType}${r.eventDate ? ` on ${r.eventDate.toISOString().slice(0, 10)}` : ""}: ${r.description.slice(0, 120)}`,
          confidence: r.confidence,
          model: { provider: r.modelProvider, modelName: r.modelName, modelVersion: r.modelVersion },
          reviewStatus: r.reviewStatus,
          createdAt: r.createdAt,
        });
      }
    }
    if (wants("TIMELINE_CONFLICT")) {
      const rows = await db.aITimelineConflict.findMany({
        where: { status: "UNREVIEWED", ...(q.caseRef ? { caseRef: q.caseRef } : {}) },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.caseRef)) continue;
        items.push({
          reviewKey: "TIMELINE_CONFLICT",
          resultType: "TIMELINE_CONFLICT",
          resultId: r.id,
          caseRef: r.caseRef,
          documentRef: null,
          summary: r.description || r.conflictType,
          confidence: null,
          model: { provider: "derived", modelName: "conflict-detection", modelVersion: "1.0.0" },
          reviewStatus: r.status,
          createdAt: r.createdAt,
        });
      }
    }
    if (wants("RELATIONSHIP")) {
      const rows = await db.aIRelationshipSuggestion.findMany({
        where: { status: "SUGGESTED", ...(q.caseRef ? { caseRef: q.caseRef } : {}) },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.caseRef)) continue;
        if (q.model && !`pipeline`.includes(q.model)) continue;
        if (q.minConfidence !== undefined && r.confidence < q.minConfidence) continue;
        if (q.maxConfidence !== undefined && r.confidence > q.maxConfidence) continue;
        items.push({
          reviewKey: "RELATIONSHIP",
          resultType: "RELATIONSHIP",
          resultId: r.id,
          caseRef: r.caseRef,
          documentRef: r.sourceDocumentRef,
          summary: `${r.sourceDocumentRef} → ${r.relationshipType} → ${r.targetDocumentRef}: ${r.reason || ""}`.slice(0, 200),
          confidence: r.confidence,
          model: { provider: "pipeline", modelName: "relationship-discovery", modelVersion: "1.0.0" },
          reviewStatus: r.status,
          createdAt: r.createdAt,
        });
      }
    }
    if (wants("ENTITY_MATCH")) {
      const rows = await db.entityCandidateMatch.findMany({
        where: { status: "SUGGESTED" },
        include: { entityA: { select: { caseRef: true } } },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      for (const r of rows) {
        if (!inScope(r.entityA.caseRef)) continue;
        if (q.caseRef && r.entityA.caseRef !== q.caseRef) continue;
        items.push({
          reviewKey: "ENTITY_MATCH",
          resultType: "ENTITY_MATCH",
          resultId: r.id,
          caseRef: r.entityA.caseRef,
          documentRef: null,
          summary: `Possible same-person candidates (similarity ${Math.round(r.similarityScore * 100)}%) — confirmation required`,
          confidence: r.similarityScore,
          model: { provider: "pipeline", modelName: "entity-matching", modelVersion: "1.0.0" },
          reviewStatus: r.status,
          createdAt: r.createdAt,
        });
      }
    }

    items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const total = items.length;
    const page = items.slice(q.offset, q.offset + q.limit);
    return jsonOk({ items: page, total });
  } catch (err) {
    return handleApiError(err);
  }
}
