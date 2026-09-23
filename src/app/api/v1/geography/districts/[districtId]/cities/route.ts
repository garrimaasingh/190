import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCitySchema } from "@/lib/validation";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { clientIp } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/v1/geography/districts/{districtId}/cities (spec §30)
export async function GET(req: Request, { params }: { params: Promise<{ districtId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.ORG_READ);
    const { districtId } = await params;
    const district = await db.district.findUnique({ where: { id: districtId } });
    if (!district) throw new ApiError(404, "NOT_FOUND", "District not found.");
    const cities = await db.city.findMany({
      where: { districtId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, status: true, districtId: true },
    });
    return jsonOk(cities);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/geography/districts/{districtId}/cities — SYSTEM_ADMIN hierarchy management
export async function POST(req: Request, { params }: { params: Promise<{ districtId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.ORG_MANAGE);
    const { districtId } = await params;
    const body = await req.json().catch(() => ({}));
    const data = createCitySchema.omit({ districtId: true }).parse(body);

    const district = await db.district.findUnique({ where: { id: districtId } });
    if (!district) throw new ApiError(404, "NOT_FOUND", "District not found.");

    const city = await db.city.create({
      data: { districtId, name: data.name, code: data.code },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.GEOGRAPHY_CREATED,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CITY",
      targetId: city.id,
      metadata: { name: city.name, code: city.code, districtId },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(city, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
