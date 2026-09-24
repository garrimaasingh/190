import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addCaseDepartmentSchema } from "@/lib/validation";
import { assertCaseManageWithPermission, assertCaseView } from "@/lib/cases/access";
import { assertCaseMutable } from "@/lib/cases/status";
import { recordCaseEvent } from "@/lib/cases/events";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/departments — participating departments.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow } = await assertCaseView(ctx, caseId);

    const rows = await db.caseDepartment.findMany({
      where: { caseId: caseRow.id },
      orderBy: { joinedAt: "asc" },
      include: {
        department: { select: { id: true, departmentCode: true, name: true, departmentType: true, status: true } },
      },
    });

    return jsonOk({
      items: rows.map((r) => ({
        id: r.id,
        department: r.department,
        participationType: r.participationType,
        status: r.status,
        isOrigin: r.departmentId === caseRow.originatingDepartmentId,
        isCustodian: r.departmentId === caseRow.currentCustodianDepartmentId,
        joinedAt: r.joinedAt,
        leftAt: r.leftAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/cases/{caseId}/departments — add participating department
// (spec §12). The department must exist and be ACTIVE. ORIGINATING /
// ACTIVE_CUSTODIAN are never assignable here — custody moves only through
// the transfer workflow.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_DEPARTMENT_MANAGE);
    const { caseId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_DEPARTMENT_MANAGE);
    assertCaseMutable(caseRow.status, "add departments");

    const body = await req.json().catch(() => ({}));
    const data = addCaseDepartmentSchema.parse(body);

    const department = await db.department.findFirst({
      where: { OR: [{ id: data.departmentId }, { departmentCode: data.departmentId }] },
    });
    if (!department) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Department not found.");
    if (department.status !== "ACTIVE") {
      throw new ApiError(422, ERROR_CODES.DEPARTMENT_INELIGIBLE, "An inactive department cannot be added to a case.");
    }

    const existing = await db.caseDepartment.findUnique({
      where: { caseId_departmentId: { caseId: caseRow.id, departmentId: department.id } },
    });
    if (existing && existing.status === "ACTIVE") {
      throw new ApiError(409, ERROR_CODES.CONFLICT, "This department already participates in the case.");
    }

    const saved = existing
      ? await db.caseDepartment.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            participationType: data.participationType,
            leftAt: null,
            addedByOfficerId: ctx.officer.id,
            note: data.note || null,
          },
        })
      : await db.caseDepartment.create({
          data: {
            caseId: caseRow.id,
            departmentId: department.id,
            participationType: data.participationType,
            addedByOfficerId: ctx.officer.id,
            note: data.note || null,
          },
        });

    await recordCaseEvent({
      eventType: "CASE_DEPARTMENT_ADDED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CASE_DEPARTMENT",
      targetId: department.departmentCode,
      description: `${department.name} added as ${data.participationType.replaceAll("_", " ").toLowerCase()} participant`,
      metadata: { departmentId: department.id, participationType: data.participationType },
    });

    return jsonOk(saved, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
