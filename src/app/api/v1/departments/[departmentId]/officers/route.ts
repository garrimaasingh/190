import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp, hashPassword } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createOfficerSchema, listQuerySchema } from "@/lib/validation";
import { assertDepartmentScope, isPlatformScoped } from "@/lib/scope";
import { generateOfficerId, } from "@/lib/ids";
import { resolveAndValidateGeoChain } from "@/lib/geo";
import { ASSIGNABLE_ROLES, OFFICER_STATUSES, PAGE_SIZES } from "@/lib/constants";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

const OFFICER_SELECT = {
  id: true,
  officerId: true,
  name: true,
  email: true,
  phone: true,
  designation: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  departmentId: true,
} as const;

// GET /api/v1/departments/{departmentId}/officers — Officer Directory (spec §23)
export async function GET(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_READ);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");
    assertDepartmentScope(ctx, department.id);

    const url = new URL(req.url);
    const q = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where: Record<string, unknown> = { departmentId };
    if (q.search) {
      where.OR = [
        { name: { contains: q.search } },
        { officerId: { contains: q.search.toUpperCase() } },
        { email: { contains: q.search.toLowerCase() } },
      ];
    }
    if (q.status && (OFFICER_STATUSES as readonly string[]).includes(q.status)) {
      where.status = q.status;
    }

    const pageSize = Math.min(q.pageSize || PAGE_SIZES.DEFAULT, PAGE_SIZES.MAX);
    const [total, rows] = await Promise.all([
      db.officer.count({ where }),
      db.officer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        select: OFFICER_SELECT,
      }),
    ]);

    return jsonOk({ items: rows, total, page: q.page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/departments/{departmentId}/officers — registration (spec §24)
// The department comes from the URL and is scope-checked; the
// role is validated against ASSIGNABLE_ROLES to prevent
// privilege escalation.
export async function POST(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_CREATE);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");
    assertDepartmentScope(ctx, department.id);

    if (department.status !== "ACTIVE") {
      throw new ApiError(422, "VALIDATION_ERROR", "Officers can only be registered to an ACTIVE department.");
    }

    const body = await req.json().catch(() => ({}));
    const data = createOfficerSchema.parse(body);

    const assignable = ASSIGNABLE_ROLES[ctx.officer.role] || [];
    if (!assignable.includes(data.role)) {
      throw new ApiError(403, "FORBIDDEN", `Role ${data.role} cannot be assigned by ${ctx.officer.role}.`);
    }

    const geo = await resolveAndValidateGeoChain({
      stateId: department.stateId,
      districtId: department.districtId,
      cityId: department.cityId,
    });

    const officerId = await generateOfficerId(geo);

    const officer = await db.officer.create({
      data: {
        officerId,
        departmentId: department.id,
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        designation: data.designation,
        role: data.role,
        status: data.status || "ACTIVE",
        passwordHash: hashPassword(data.password),
      },
      select: OFFICER_SELECT,
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_CREATED,
      actorOfficerId: ctx.officer.id,
      departmentId: department.id,
      targetType: "OFFICER",
      targetId: officer.id,
      metadata: { officerId: officer.officerId, role: officer.role, status: officer.status },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(officer, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
