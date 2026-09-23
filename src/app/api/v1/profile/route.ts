import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, hashPassword, verifyPassword, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateProfileSchema, changePasswordSchema } from "@/lib/validation";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// GET /api/v1/profile — own profile (spec §41)
// Only server-derived identity data is returned; authentication
// internals (hashes) are never exposed.
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.PROFILE_READ);

    const officer = await db.officer.findUnique({
      where: { id: ctx.officer.id },
      include: {
        department: {
          include: { city: { include: { district: { include: { state: { include: { country: true } } } } } } },
        },
      },
    });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

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
        logoPath: officer.department.logoPath,
        geography: {
          country: officer.department.city.district.state.country.name,
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

// PATCH /api/v1/profile — self-service edit of permitted fields only.
// Name, email, role, designation and status are server-controlled
// identity fields and are intentionally not editable here.
export async function PATCH(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.PROFILE_UPDATE);
    const body = await req.json().catch(() => ({}));
    const data = updateProfileSchema.parse(body);

    const updated = await db.officer.update({
      where: { id: ctx.officer.id },
      data: { ...(data.phone !== undefined ? { phone: data.phone || null } : {}) },
      select: { id: true, officerId: true, phone: true },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_UPDATED,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "OFFICER",
      targetId: ctx.officer.id,
      metadata: { fields: Object.keys(data), self: true },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/profile/password — change own password.
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.PASSWORD_UPDATE);
    const body = await req.json().catch(() => ({}));
    const { currentPassword, newPassword } = changePasswordSchema.parse(body);

    const officer = await db.officer.findUnique({ where: { id: ctx.officer.id } });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

    if (!verifyPassword(currentPassword, officer.passwordHash)) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
    }

    await db.officer.update({
      where: { id: officer.id },
      data: { passwordHash: hashPassword(newPassword) },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_PASSWORD_CHANGED,
      actorOfficerId: officer.id,
      departmentId: officer.departmentId,
      targetType: "OFFICER",
      targetId: officer.id,
      metadata: { self: true },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk({ changed: true });
  } catch (err) {
    return handleApiError(err);
  }
}
