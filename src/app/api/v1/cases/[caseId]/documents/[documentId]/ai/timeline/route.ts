import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/timeline
// AI timeline SUGGESTIONS for this document (spec §17) — separate
// from the official case timeline (spec §71).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    const rows = await db.aITimelineEvent.findMany({ where: { documentId: doc.id }, orderBy: { eventDate: "asc" } });
    return jsonOk({
      timelineEvents: rows.map((t) => ({
        id: t.id,
        eventDate: t.eventDate,
        eventDateText: t.eventDateText,
        eventTime: t.eventTime,
        eventType: t.eventType,
        description: t.description,
        sourceReference: t.sourceReference,
        confidence: t.confidence,
        reviewStatus: t.reviewStatus,
        model: { provider: t.modelProvider, modelName: t.modelName, modelVersion: t.modelVersion },
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
