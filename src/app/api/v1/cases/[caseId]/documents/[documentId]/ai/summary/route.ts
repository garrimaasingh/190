import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const querySchema = z.object({
  type: z.enum(["SHORT", "DETAILED", "EXECUTIVE"]).optional(),
});

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/summary
// Summaries with source references (spec §14/§15). All stored
// versions are returned — the newest is flagged `latest`.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    const url = new URL(req.url);
    const q = querySchema.parse(Object.fromEntries(url.searchParams));

    const rows = await db.aIDocumentSummary.findMany({
      where: { documentId: doc.id, summaryType: { not: "CASE_CONTEXT" }, ...(q.type ? { summaryType: q.type } : {}) },
      orderBy: { createdAt: "desc" },
    });
    const latestByType = new Map<string, string>();
    for (const r of rows) if (!latestByType.has(r.summaryType)) latestByType.set(r.summaryType, r.id);

    return jsonOk({
      summaries: rows.map((s) => ({
        id: s.id,
        summaryType: s.summaryType,
        summaryText: s.summaryText,
        sourceReferences: s.sourceReferences ? JSON.parse(s.sourceReferences) : [],
        latest: latestByType.get(s.summaryType) === s.id,
        reviewStatus: s.reviewStatus,
        model: { provider: s.modelProvider, modelName: s.modelName, modelVersion: s.modelVersion },
        jobId: s.jobId,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
