import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createStateSchema } from "@/lib/validation";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { clientIp } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/v1/geography/states?countryId=...
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.ORG_READ);
    const url = new URL(req.url);
    const countryId = url.searchParams.get("countryId") || undefined;
    const states = await db.state.findMany({
      where: countryId ? { countryId } : undefined,
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, status: true, countryId: true },
    });
    return jsonOk(states);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/geography/states — manage organizational hierarchy (SYSTEM_ADMIN, spec §26)
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.ORG_MANAGE);
    const body = await req.json().catch(() => ({}));
    const data = createStateSchema.parse(body);

    const country = await db.country.findUnique({ where: { id: data.countryId } });
    if (!country) throw new ApiError(404, "NOT_FOUND", "Country not found.");

    const state = await db.state.create({
      data: { countryId: data.countryId, name: data.name, code: data.code },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.GEOGRAPHY_CREATED,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "STATE",
      targetId: state.id,
      metadata: { name: state.name, code: state.code },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(state, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
