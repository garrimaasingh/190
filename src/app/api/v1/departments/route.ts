import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createDepartmentSchema, listQuerySchema } from "@/lib/validation";
import { resolveAndValidateGeoChain } from "@/lib/geo";
import { generateDepartmentCode } from "@/lib/ids";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { DEPARTMENT_STATUSES, DEPARTMENT_TYPES, PAGE_SIZES } from "@/lib/constants";

export const runtime = "nodejs";

const SELECT = {
  id: true,
  departmentCode: true,
  name: true,
  departmentType: true,
  description: true,
  logoPath: true,
  status: true,
  stateId: true,
  districtId: true,
  cityId: true,
  createdAt: true,
  city: { select: { name: true, district: { select: { name: true, state: { select: { name: true, code: true } } } } } },
  _count: { select: { officers: true } },
} as const;

// GET /api/v1/departments — centralized Department Directory (spec §22)
// Supports: search, filter by state/district/city/type/status, pagination.
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.DEPARTMENT_READ);
    const url = new URL(req.url);
    const q = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where: Record<string, unknown> = {};
    if (q.search) {
      where.OR = [
        { name: { contains: q.search } },
        { departmentCode: { contains: q.search.toUpperCase() } },
      ];
    }
    if (q.stateId) where.stateId = q.stateId;
    if (q.districtId) where.districtId = q.districtId;
    if (q.cityId) where.cityId = q.cityId;
    if (q.departmentType && (DEPARTMENT_TYPES as readonly string[]).includes(q.departmentType)) {
      where.departmentType = q.departmentType;
    }
    if (q.status && (DEPARTMENT_STATUSES as readonly string[]).includes(q.status)) {
      where.status = q.status;
    }

    const pageSize = Math.min(q.pageSize || PAGE_SIZES.DEFAULT, PAGE_SIZES.MAX);
    const [total, rows] = await Promise.all([
      db.department.count({ where }),
      db.department.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        select: SELECT,
      }),
    ]);

    const items = rows.map((d) => ({
      id: d.id,
      departmentCode: d.departmentCode,
      name: d.name,
      departmentType: d.departmentType,
      description: d.description,
      logoPath: d.logoPath,
      status: d.status,
      createdAt: d.createdAt,
      location: {
        city: d.city?.name ?? null,
        district: d.city?.district?.name ?? null,
        state: d.city?.district?.state?.name ?? null,
      },
      officerCount: d._count.officers,
    }));

    return jsonOk({ items, total, page: q.page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/departments — registration (SYSTEM_ADMIN, spec §9/§26)
// Backend re-validates the geographic hierarchy; frontend
// dropdown filtering is treated as UX only, never as security.
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DEPARTMENT_CREATE);
    const body = await req.json().catch(() => ({}));
    const data = createDepartmentSchema.parse(body);

    const geo = await resolveAndValidateGeoChain({
      stateId: data.stateId,
      districtId: data.districtId,
      cityId: data.cityId,
    });

    const departmentCode = await generateDepartmentCode(geo, data.departmentType);

    const department = await db.department.create({
      data: {
        departmentCode,
        name: data.name,
        departmentType: data.departmentType,
        description: data.description || null,
        stateId: geo.state.id,
        districtId: geo.district.id,
        cityId: geo.city.id,
        status: "PENDING",
      },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.DEPARTMENT_CREATED,
      actorOfficerId: ctx.officer.id,
      departmentId: department.id,
      targetType: "DEPARTMENT",
      targetId: department.id,
      metadata: { departmentCode, departmentType: data.departmentType, city: geo.city.name },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(
      {
        ...department,
        location: { city: geo.city.name, district: geo.district.name, state: geo.state.name, country: geo.country.name },
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}
