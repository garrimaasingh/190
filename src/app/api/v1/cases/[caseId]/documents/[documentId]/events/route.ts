import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertDocumentViewable } from "@/lib/documents/routing";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId}/events
// Document activity stream (spec §51/§52/§63 ACTIVITY). The actor
// must be authorized to view the document; events contain no
// document content — only actor/result/minimal metadata.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    const events = await db.documentEvent.findMany({
      where: { documentId: doc.id },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const actorIds = Array.from(new Set(events.map((e) => e.actorOfficerId).filter((v): v is string => !!v)));
    const actors = actorIds.length
      ? await db.officer.findMany({ where: { id: { in: actorIds } }, select: { id: true, officerId: true, name: true } })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    return jsonOk({
      documentId: doc.documentId,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        result: e.result,
        actor: e.actorOfficerId ? actorMap.get(e.actorOfficerId) ?? null : null,
        createdAt: e.createdAt,
        metadata: e.metadata ? (JSON.parse(e.metadata) as Record<string, unknown>) : null,
      })),
      caseId: caseRow.caseId,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
