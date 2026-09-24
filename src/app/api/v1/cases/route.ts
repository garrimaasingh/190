import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCaseSchema, caseListQuerySchema } from "@/lib/validation";
import { resolveAndValidateGeoChain } from "@/lib/geo";
import { generateCaseId } from "@/lib/cases/ids";
import { recordCaseEvent } from "@/lib/cases/events";
import {
  ERROR_CODES,
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  PAGE_SIZES,
} from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/cases — case creation (spec §15/§16/§17).
// The creating officer's department (derived from the session) becomes the
// originating department AND the initial custodian. The client can NEVER
// supply creator/department/custodian/status — forged fields are ignored
// because they are simply not read.
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_CREATE);
    const body = await req.json().catch(() => ({}));
    const data = createCaseSchema.parse(body);

    if (ctx.department.status !== "ACTIVE") {
      throw new ApiError(422, ERROR_CODES.DEPARTMENT_INELIGIBLE, "Your department is not active; cases cannot be created.");
    }

    // Backend-validated geography (spec §9): city ⊂ district ⊂ state.
    const geo = await resolveAndValidateGeoChain({
      stateId: data.stateId,
      districtId: data.districtId,
      cityId: data.cityId,
      requireActive: true,
    });

    // Duplicate official reference policy (spec §17): a case number must be
    // unique within the originating department.
    if (data.caseNumber) {
      const dup = await db.case.findFirst({
        where: { caseNumber: data.caseNumber, createdByDepartmentId: ctx.officer.departmentId },
        select: { caseId: true },
      });
      if (dup) {
        throw new ApiError(
          409,
          ERROR_CODES.CONFLICT,
          `Case number "${data.caseNumber}" is already registered by your department (${dup.caseId}).`
        );
      }
    }

    const year = new Date().getFullYear();
    const caseId = await generateCaseId(geo, year);

    const created = await db.$transaction(async (tx) => {
      const caseRow = await tx.case.create({
        data: {
          caseId,
          caseNumber: data.caseNumber ?? null,
          title: data.title,
          description: data.description ?? null,
          caseType: data.caseType,
          caseCategory: data.caseCategory ?? null,
          priority: data.priority,
          status: "OPEN",
          stateId: geo.state.id,
          districtId: geo.district.id,
          cityId: geo.city.id,
          originatingDepartmentId: ctx.officer.departmentId,
          currentCustodianDepartmentId: ctx.officer.departmentId,
          currentCustodianOfficerId: ctx.officer.id,
          createdByOfficerId: ctx.officer.id,
          createdByDepartmentId: ctx.officer.departmentId,
          openedAt: new Date(),
        },
      });

      // Origin == initial custodian → a single ORIGINATING participation row.
      await tx.caseDepartment.create({
        data: {
          caseId: caseRow.id,
          departmentId: ctx.officer.departmentId,
          participationType: "ORIGINATING",
          addedByOfficerId: ctx.officer.id,
        },
      });

      await recordCaseEvent(
        {
          eventType: "CASE_CREATED",
          caseId: caseRow.id,
          actorOfficerId: ctx.officer.id,
          departmentId: ctx.officer.departmentId,
          targetType: "CASE",
          targetId: caseRow.caseId,
          description: `Case created by ${ctx.officer.name} (${ctx.department.name})`,
          metadata: { caseType: data.caseType, priority: data.priority },
        },
        tx
      );

      return caseRow;
    });

    return jsonOk(
      {
        id: created.id,
        caseId: created.caseId,
        title: created.title,
        status: created.status,
        priority: created.priority,
        caseType: created.caseType,
        originatingDepartment: { id: ctx.department.id, name: ctx.department.name },
        currentCustodianDepartment: { id: ctx.department.id, name: ctx.department.name },
        createdByOfficer: { id: ctx.officer.id, name: ctx.officer.name },
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// GET /api/v1/cases — authorized search & directory (spec §30/§31/§50).
// Authorization is applied AT THE QUERY LEVEL — unauthorized cases are
// never fetched, let alone filtered in the frontend.
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const url = new URL(req.url);
    const q = caseListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where: Record<string, unknown> = {};
    const platformWide = ctx.officer.role === "SYSTEM_ADMIN" || ctx.officer.role === "AUDITOR";

    if (platformWide) {
      if (q.custodianDepartmentId) where.currentCustodianDepartmentId = q.custodianDepartmentId;
      if (q.originatingDepartmentId) where.originatingDepartmentId = q.originatingDepartmentId;
    } else if (ctx.officer.role === "DEPARTMENT_ADMIN") {
      // Departments see cases they participate in (origin/custodian/participant).
      where.departments = { some: { departmentId: ctx.officer.departmentId, status: "ACTIVE" } };
    } else {
      // OFFICER: explicit assignment or their department is the current custodian.
      where.OR = [
        { currentCustodianDepartmentId: ctx.officer.departmentId },
        { officers: { some: { officerId: ctx.officer.id, status: "ACTIVE" } } },
      ];
    }

    if (q.search) {
      const s = q.search;
      where.AND = [
        {
          OR: [
            { caseId: { contains: s.toUpperCase() } },
            { caseNumber: { contains: s } },
            { title: { contains: s } },
          ],
        },
      ];
    }
    if (q.caseType && (CASE_TYPES as readonly string[]).includes(q.caseType)) where.caseType = q.caseType;
    if (q.priority && (CASE_PRIORITIES as readonly string[]).includes(q.priority)) where.priority = q.priority;
    if (q.status && (CASE_STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
    if (q.stateId) where.stateId = q.stateId;
    if (q.districtId) where.districtId = q.districtId;
    if (q.cityId) where.cityId = q.cityId;
    if (q.createdFrom || q.createdTo) {
      const range: Record<string, Date> = {};
      const from = q.createdFrom ? new Date(q.createdFrom) : null;
      const to = q.createdTo ? new Date(q.createdTo) : null;
      if (from && !isNaN(from.getTime())) range.gte = from;
      if (to && !isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        range.lte = to;
      }
      if (Object.keys(range).length > 0) where.createdAt = range;
    }

    const pageSize = Math.min(q.pageSize || PAGE_SIZES.DEFAULT, PAGE_SIZES.MAX);
    const [total, rows] = await Promise.all([
      db.case.count({ where }),
      db.case.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          caseId: true,
          caseNumber: true,
          title: true,
          caseType: true,
          priority: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          originatingDepartment: { select: { id: true, name: true, departmentType: true } },
          currentCustodianDepartment: { select: { id: true, name: true, departmentType: true } },
          district: { select: { name: true } },
          city: { select: { name: true } },
        },
      }),
    ]);

    return jsonOk({ items: rows, total, page: q.page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}
