import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateOfficerSchema } from "@/lib/validation";
import { assertDepartmentScope } from "@/lib/scope";
import { ASSIGNABLE_ROLES } from "@/lib/constants";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// GET /api/v1/officers/{officerId} — officer profile (spec §11/§41)
export async function GET(req: Request, { params }: { params: Promise<{ officerId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_READ);
    const { officerId: officerDbId } = await params;

    const officer = await db.officer.findUnique({
      where: { id: officerDbId },
      include: {
        department: {
          include: { city: { include: { district: { include: { state: true } } } } },
        },
      },
    });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

    assertDepartmentScope(ctx, officer.departmentId);

    return jsonOk({
      id: officer.id,
      officerId: officer.officerId,
      name: officer.name,
      email: officer.email,
      phone: officer.phone,
      designation: officer.designation,
      role: officer.role,
      status: officer.status,
      lastLoginAt: officer.lastLoginAt,
      createdAt: officer.createdAt,
      department: {
        id: officer.department.id,
        departmentCode: officer.department.departmentCode,
        name: officer.department.name,
        departmentType: officer.department.departmentType,
        geography: {
          state: officer.department.city.district.state.name,
          district: officer.department.city.district.name,
          city: officer.department.city.name,
        },
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// PATCH /api/v1/officers/{officerId} — update (role assignment, spec §10/§23)
export async function PATCH(req: Request, { params }: { params: Promise<{ officerId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_UPDATE);
    const { officerId: officerDbId } = await params;

    const officer = await db.officer.findUnique({ where: { id: officerDbId } });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

    assertDepartmentScope(ctx, officer.departmentId);

    const body = await req.json().catch(() => ({}));
    const data = updateOfficerSchema.parse(body);

    if (data.role !== undefined && data.role !== officer.role) {
      const assignable = ASSIGNABLE_ROLES[ctx.officer.role] || [];
      if (!assignable.includes(data.role)) {
        throw new ApiError(403, "FORBIDDEN", `Role ${data.role} cannot be assigned by ${ctx.officer.role}.`);
      }
      if (officer.role === "SYSTEM_ADMIN") {
        throw new ApiError(403, "FORBIDDEN", "The platform system administrator cannot be modified here.");
      }
    }

    const updated = await db.officer.update({
      where: { id: officer.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
        ...(data.designation !== undefined ? { designation: data.designation } : {}),
        ...(data.role !== undefined ? { role: data.role } : {}),
      },
      select: {
        id: true, officerId: true, name: true, email: true, phone: true,
        designation: true, role: true, status: true, lastLoginAt: true, departmentId: true,
      },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_UPDATED,
      actorOfficerId: ctx.officer.id,
      departmentId: officer.departmentId,
      targetType: "OFFICER",
      targetId: officer.id,
      metadata: { fields: Object.keys(data), officerId: officer.officerId },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
