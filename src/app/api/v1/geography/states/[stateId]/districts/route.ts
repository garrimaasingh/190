import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createDistrictSchema } from "@/lib/validation";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { clientIp } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/v1/geography/states/{stateId}/districts (spec §30)
export async function GET(req: Request, { params }: { params: Promise<{ stateId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.ORG_READ);
    const { stateId } = await params;
    const state = await db.state.findUnique({ where: { id: stateId } });
    if (!state) throw new ApiError(404, "NOT_FOUND", "State not found.");
    const districts = await db.district.findMany({
      where: { stateId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, status: true, stateId: true },
    });
    return jsonOk(districts);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/geography/states/{stateId}/districts — SYSTEM_ADMIN hierarchy management
export async function POST(req: Request, { params }: { params: Promise<{ stateId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.ORG_MANAGE);
    const { stateId } = await params;
    const body = await req.json().catch(() => ({}));
    const data = createDistrictSchema.omit({ stateId: true }).parse(body);

    const state = await db.state.findUnique({ where: { id: stateId } });
    if (!state) throw new ApiError(404, "NOT_FOUND", "State not found.");

    const district = await db.district.create({
      data: { stateId, name: data.name, code: data.code },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.GEOGRAPHY_CREATED,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "DISTRICT",
      targetId: district.id,
      metadata: { name: district.name, code: district.code, stateId },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(district, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
