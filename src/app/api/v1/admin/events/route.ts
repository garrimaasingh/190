import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listQuerySchema } from "@/lib/validation";
import { PAGE_SIZES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/admin/events — read-only identity event listing.
// Phase 4 will migrate this to the immutable audit system;
// the read contract stays stable.
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.EVENTS_READ);
    const url = new URL(req.url);
    const q = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where: Record<string, unknown> = {};
    if (q.search) where.eventType = { contains: q.search.toUpperCase() };

    const pageSize = Math.min(q.pageSize || PAGE_SIZES.DEFAULT, PAGE_SIZES.MAX);
    const [total, rows] = await Promise.all([
      db.identityEvent.count({ where }),
      db.identityEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return jsonOk({
      items: rows.map((e) => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })),
      total,
      page: q.page,
      pageSize,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
