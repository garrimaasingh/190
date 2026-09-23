import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { permissionsForRole } from "@/lib/permissions";

export const runtime = "nodejs";

// GET /api/v1/auth/me — authenticated identity bundle (spec §19).
// All fields are server-derived; the client never supplies them.
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req);

    const department = await db.department.findUnique({
      where: { id: ctx.officer.departmentId },
      include: {
        city: { include: { district: { include: { state: { include: { country: true } } } } } },
      },
    });

    const chain = department
      ? {
          country: department.city.district.state.country.name,
          state: department.city.district.state.name,
          district: department.city.district.name,
          city: department.city.name,
        }
      : null;

    return jsonOk({
      officer: {
        id: ctx.officer.id,
        officerId: ctx.officer.officerId,
        name: ctx.officer.name,
        email: ctx.officer.email,
        phone: ctx.officer.phone,
        designation: ctx.officer.designation,
        role: ctx.officer.role,
        status: ctx.officer.status,
        lastLoginAt: ctx.officer.lastLoginAt,
      },
      department: department
        ? {
            id: department.id,
            departmentCode: department.departmentCode,
            name: department.name,
            departmentType: department.departmentType,
            description: department.description,
            status: department.status,
            logoPath: department.logoPath,
            createdAt: department.createdAt,
            geography: chain,
          }
        : null,
      permissions: permissionsForRole(ctx.officer.role),
      session: { sessionId: ctx.sessionId },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
