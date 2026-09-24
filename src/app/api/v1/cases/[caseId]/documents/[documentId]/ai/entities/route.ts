import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const querySchema = z.object({
  type: z.string().optional(),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED", "OVERRIDDEN"]).optional(),
  page: z.coerce.number().int().min(0).optional(),
});

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/entities
// Extracted entities with FULL PROVENANCE (spec §11/§12): every
// entity carries document → page → text offset → snippet so the UI
// can offer "Open Source". AI-extracted vs human-verified are
// distinguishable via reviewStatus.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    const url = new URL(req.url);
    const q = querySchema.parse(Object.fromEntries(url.searchParams));

    const entities = await db.extractedEntity.findMany({
      where: {
        documentId: doc.id,
        ...(q.type ? { entityType: q.type } : {}),
        ...(q.status ? { reviewStatus: q.status } : {}),
        ...(q.page !== undefined ? { pageNumber: q.page } : {}),
      },
      orderBy: [{ pageNumber: "asc" }, { startOffset: "asc" }],
    });
    const texts = await db.documentText.findMany({ where: { documentId: doc.id }, select: { pageNumber: true, text: true } });
    const pageText = new Map(texts.map((t) => [t.pageNumber, t.text]));

    return jsonOk({
      entities: entities.map((e) => {
        const text = pageText.get(e.pageNumber) || "";
        const start = e.startOffset ?? Math.max(0, text.indexOf(e.originalText));
        const snippet =
          text && start >= 0 ? text.slice(Math.max(0, start - 80), Math.min(text.length, start + e.originalText.length + 80)).trim() : null;
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
            reference: e.sourceReference,
          },
          model: { provider: e.modelProvider, modelName: e.modelName, modelVersion: e.modelVersion },
          reviewedByOfficerId: e.reviewedByOfficerId,
          reviewedAt: e.reviewedAt,
          createdAt: e.createdAt,
        };
      }),
      total: entities.length,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
