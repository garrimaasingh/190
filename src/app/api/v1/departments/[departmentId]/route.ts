import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateDepartmentSchema } from "@/lib/validation";
import { assertDepartmentScope } from "@/lib/scope";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// GET /api/v1/departments/{departmentId} — department profile (spec §39)
export async function GET(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DEPARTMENT_READ);
    const { departmentId } = await params;

    const department = await db.department.findUnique({
      where: { id: departmentId },
      include: {
        city: { include: { district: { include: { state: { include: { country: true } } } } } },
        officers: { select: { id: true, officerId: true, name: true, role: true, status: true } },
      },
    });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");

    assertDepartmentScope(ctx, department.id);

    const administrators = department.officers.filter((o) => o.role === "DEPARTMENT_ADMIN" || o.role === "SYSTEM_ADMIN");

    return jsonOk({
      id: department.id,
      departmentCode: department.departmentCode,
      name: department.name,
      departmentType: department.departmentType,
      description: department.description,
      logoPath: department.logoPath,
      status: department.status,
      createdAt: department.createdAt,
      updatedAt: department.updatedAt,
      geography: {
        country: department.city.district.state.country.name,
        state: department.city.district.state.name,
        district: department.city.district.name,
        city: department.city.name,
      },
      officerCount: department.officers.length,
      administrators,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// PATCH /api/v1/departments/{departmentId} — update profile (spec §10/§39)
export async function PATCH(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DEPARTMENT_UPDATE);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");

    assertDepartmentScope(ctx, department.id);

    const body = await req.json().catch(() => ({}));
    const data = updateDepartmentSchema.parse(body);

    const updated = await db.department.update({
      where: { id: department.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description || null } : {}),
      },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.DEPARTMENT_UPDATED,
      actorOfficerId: ctx.officer.id,
      departmentId: department.id,
      targetType: "DEPARTMENT",
      targetId: department.id,
      metadata: { fields: Object.keys(data) },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
