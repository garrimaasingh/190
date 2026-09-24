import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/ai/dashboard (spec §42)
// AI processing statistics + review queue counters, scoped to the
// caller's authorization (counts computed over authorized cases).
export async function GET(req: Request) {
  try {
    const { ctx } = await requireAIAccess(req);
    const scope = await buildAuthorizedScope(ctx);
    const refs = [...scope.keys()];
    const caseFilter = { caseRef: { in: refs.length ? refs : ["__none__"] } };

    const [jobsByStatus, processedDocs, ocrResults, classificationPending, entitiesPending, summaries, timelinePending, conflictsUnreviewed, relSuggestions, recentJobs] =
      await Promise.all([
        db.aIProcessingJob.groupBy({ by: ["status"], where: caseFilter, _count: { _all: true } }),
        db.aIProcessingJob.findMany({
          where: { ...caseFilter, documentRef: { not: null }, status: { in: ["COMPLETED", "PARTIAL"] } },
          select: { documentRef: true },
          distinct: ["documentRef"],
        }),
        db.ocrResult.count({ where: { document: { case: { caseId: { in: refs.length ? refs : ["__none__"] } } } } }),
        db.aIDocumentClassification.count({ where: { ...caseFilter, reviewStatus: "PENDING" } }),
        db.extractedEntity.count({ where: { ...caseFilter, reviewStatus: "PENDING" } }),
        db.aIDocumentSummary.count({ where: caseFilter }),
        db.aITimelineEvent.count({ where: { ...caseFilter, reviewStatus: "PENDING" } }),
        db.aITimelineConflict.count({ where: { ...caseFilter, status: "UNREVIEWED" } }),
        db.aIRelationshipSuggestion.count({ where: { ...caseFilter, status: "SUGGESTED" } }),
        db.aIProcessingJob.findMany({
          where: caseFilter,
          orderBy: { createdAt: "desc" },
          take: 8,
          select: { jobId: true, jobType: true, status: true, documentRef: true, caseRef: true, createdAt: true, completedAt: true, errorMessage: true },
        }),
      ]);

    const statusCounts: Record<string, number> = {};
    for (const g of jobsByStatus) statusCounts[g.status] = g._count._all;

    return jsonOk({
      processing: {
        queued: statusCounts["QUEUED"] || 0,
        processingNow: statusCounts["PROCESSING"] || 0,
        completed: statusCounts["COMPLETED"] || 0,
        partial: statusCounts["PARTIAL"] || 0,
        failed: statusCounts["FAILED"] || 0,
        cancelled: statusCounts["CANCELLED"] || 0,
        documentsProcessed: processedDocs.length,
      },
      intelligence: {
        ocrResults,
        classificationSuggestionsPending: classificationPending,
        entitiesPendingReview: entitiesPending,
        summaries,
        timelineSuggestionsPending: timelinePending,
        relationshipSuggestions: relSuggestions,
      },
      reviewQueue: {
        total: classificationPending + entitiesPending + timelinePending + conflictsUnreviewed,
        conflictsUnreviewed,
      },
      recentJobs,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
