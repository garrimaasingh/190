import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/relationships
// AI relationship SUGGESTIONS involving this document (spec §32).
// These are suggestions only — authoritative relationships live in
// the Phase 3 DocumentRelationship store and are created ONLY via
// human workflows.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    const [asSource, asTarget] = await Promise.all([
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
    ]);

    return jsonOk({
      suggestions: [
        ...asSource.map((r) => ({
          id: r.id,
          direction: "outgoing" as const,
          relationshipType: r.relationshipType,
          confidence: r.confidence,
          reason: r.reason,
          status: r.status,
          otherDocument: r.targetDocument,
          model: r.jobId,
          createdAt: r.createdAt,
        })),
        ...asTarget.map((r) => ({
          id: r.id,
          direction: "incoming" as const,
          relationshipType: r.relationshipType,
          confidence: r.confidence,
          reason: r.reason,
          status: r.status,
          otherDocument: r.sourceDocument,
          model: r.jobId,
          createdAt: r.createdAt,
        })),
      ],
    });
  } catch (err) {
    return handleApiError(err);
  }
}
