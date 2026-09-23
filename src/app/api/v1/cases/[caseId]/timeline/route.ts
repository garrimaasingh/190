import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseView } from "@/lib/cases/access";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/timeline — chronological case timeline
// (spec §24). Future event types extend the registry without redesign.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow } = await assertCaseView(ctx, caseId);

    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);

    const events = await db.caseEvent.findMany({
      where: { caseId: caseRow.id },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const actorIds = Array.from(new Set(events.map((e) => e.actorOfficerId).filter((v): v is string => !!v)));
    const actors = actorIds.length
      ? await db.officer.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, officerId: true, name: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const deptIds = Array.from(new Set(events.map((e) => e.departmentId).filter((v): v is string => !!v)));
    const depts = deptIds.length
      ? await db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })
      : [];
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));

    return jsonOk({
      items: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actor: e.actorOfficerId ? actorMap.get(e.actorOfficerId) ?? null : null,
        actorIdentifier: e.actorIdentifier,
        department: e.departmentId ? deptMap.get(e.departmentId) ?? null : null,
        description: e.description,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
