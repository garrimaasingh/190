import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { recordAuditEvent } from "@/lib/audit/service";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai
// (maps to spec §49 GET /api/v1/documents/{document_id}/ai)
// Full AI intelligence overview: processing status, classification
// suggestion, entities (with provenance), text pages, summaries,
// timeline suggestions, relationship suggestions, jobs.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    const [status, texts, ocr, classifications, entities, summaries, timeline, relSource, relTarget, jobs] = await Promise.all([
      import("@/lib/ai/jobs").then((m) => m.documentAIStatus(doc.id)),
      db.documentText.findMany({ where: { documentId: doc.id }, orderBy: { pageNumber: "asc" } }),
      db.ocrResult.findMany({ where: { documentId: doc.id }, orderBy: { pageNumber: "asc" } }),
      db.aIDocumentClassification.findMany({
        where: { documentId: doc.id },
        orderBy: { createdAt: "desc" },
        include: { reviewedByOfficer: { select: { officerId: true, name: true } } },
      }),
      db.extractedEntity.findMany({ where: { documentId: doc.id }, orderBy: [{ pageNumber: "asc" }, { startOffset: "asc" }] }),
      db.aIDocumentSummary.findMany({
        where: { documentId: doc.id, summaryType: { not: "CASE_CONTEXT" } },
        orderBy: { createdAt: "desc" },
      }),
      db.aITimelineEvent.findMany({ where: { documentId: doc.id }, orderBy: { eventDate: "asc" } }),
      db.aIRelationshipSuggestion.findMany({
        where: { sourceDocumentId: doc.id },
        include: { targetDocument: { select: { documentId: true, title: true, documentType: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.aIRelationshipSuggestion.findMany({
        where: { targetDocumentId: doc.id },
        include: { sourceDocument: { select: { documentId: true, title: true, documentType: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.aIProcessingJob.findMany({ where: { documentId: doc.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);

    const textPages = texts.map((t) => ({
      pageNumber: t.pageNumber,
      language: t.language,
      languageConfidence: t.languageConfidence,
      sourceType: t.sourceType,
      sourceReference: t.sourceReference,
      extractionConfidence: t.extractionConfidence,
      chars: t.text.length,
      text: t.text, // normalized derived text (spec §9)
    }));

    const entitySnippets = new Map(texts.map((t) => [t.pageNumber, t.text]));
    const entityList = entities.map((e) => {
      const pageText = entitySnippets.get(e.pageNumber) || "";
      const start = e.startOffset ?? Math.max(0, pageText.indexOf(e.originalText));
      const snippet =
        pageText && start >= 0
          ? pageText.slice(Math.max(0, start - 80), Math.min(pageText.length, start + e.originalText.length + 80)).trim()
          : null;
      return {
        id: e.id,
        entityType: e.entityType,
        originalText: e.originalText,
        normalizedValue: e.normalizedValue,
        pageNumber: e.pageNumber,
        startOffset: e.startOffset,
        endOffset: e.endOffset,
        confidence: e.confidence,
        reviewStatus: e.reviewStatus,
        source: {
          documentRef: doc.documentId,
          page: e.pageNumber,
          offset: e.startOffset,
          snippet,
          // Resolvable provenance (spec §12): document → page → text location
          reference: e.sourceReference,
          openable: e.pageNumber > 0 || ["txt", "csv", "pdf"].includes(doc.fileExtension),
        },
        model: { provider: e.modelProvider, modelName: e.modelName, modelVersion: e.modelVersion },
        reviewedByOfficerId: e.reviewedByOfficerId,
        reviewedAt: e.reviewedAt,
        createdAt: e.createdAt,
      };
    });

    await recordAuditEvent({
      eventType: "AI_RESULT_VIEWED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      documentId: doc.documentId,
      sessionId: ctx.sessionId,
      metadata: { results: ["status", "text", "entities", "classification", "summary", "timeline", "relationships"] },
    });

    return jsonOk({
      aiStatus: status,
      classification: classifications.map((c) => ({
        id: c.id,
        suggestedType: c.suggestedType,
        suggestedCategory: c.suggestedCategory,
        confidence: c.confidence,
        reason: c.reason,
        sourceReference: c.sourceReference,
        reviewStatus: c.reviewStatus,
        overrideType: c.overrideType,
        reviewedByOfficer: c.reviewedByOfficer ? { officerId: c.reviewedByOfficer.officerId, name: c.reviewedByOfficer.name } : null,
        reviewedAt: c.reviewedAt,
        model: { provider: c.modelProvider, modelName: c.modelName, modelVersion: c.modelVersion },
        createdAt: c.createdAt,
      })),
      text: textPages,
      ocr: ocr.map((o) => ({
        pageNumber: o.pageNumber,
        language: o.language,
        confidence: o.confidence,
        provider: o.provider,
        modelVersion: o.modelVersion,
        hasBoundingBoxes: !!o.boundingBoxes,
      })),
      entities: entityList,
      summaries: summaries.map((s) => ({
        id: s.id,
        summaryType: s.summaryType,
        summaryText: s.summaryText,
        sourceReferences: s.sourceReferences ? JSON.parse(s.sourceReferences) : [],
        reviewStatus: s.reviewStatus,
        model: { provider: s.modelProvider, modelName: s.modelName, modelVersion: s.modelVersion },
        createdAt: s.createdAt,
      })),
      timeline: timeline.map((t) => ({
        id: t.id,
        eventDate: t.eventDate,
        eventDateText: t.eventDateText,
        eventTime: t.eventTime,
        eventType: t.eventType,
        description: t.description,
        sourceReference: t.sourceReference,
        confidence: t.confidence,
        reviewStatus: t.reviewStatus,
        model: { provider: t.modelProvider, modelName: t.modelName },
        createdAt: t.createdAt,
      })),
      relationships: {
        outgoing: relSource.map((r) => ({
          id: r.id,
          relationshipType: r.relationshipType,
          confidence: r.confidence,
          reason: r.reason,
          status: r.status,
          target: r.targetDocument,
        })),
        incoming: relTarget.map((r) => ({
          id: r.id,
          relationshipType: r.relationshipType,
          confidence: r.confidence,
          reason: r.reason,
          status: r.status,
          source: r.sourceDocument,
        })),
      },
      jobs: jobs.map((j) => ({
        jobId: j.jobId,
        jobType: j.jobType,
        status: j.status,
        stage: j.stage,
        model: { provider: j.modelProvider, modelName: j.modelName, modelVersion: j.modelVersion },
        errorCode: j.errorCode,
        errorMessage: j.errorMessage,
        resultSummary: j.resultSummary ? JSON.parse(j.resultSummary) : null,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
