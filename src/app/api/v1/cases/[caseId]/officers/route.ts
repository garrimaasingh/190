import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addCaseOfficerSchema } from "@/lib/validation";
import { assertCaseManageWithPermission, assertCaseView } from "@/lib/cases/access";
import { assertCaseMutable } from "@/lib/cases/status";
import { recordCaseEvent } from "@/lib/cases/events";
import { AUTH_ALLOWED_STATUSES, ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/officers — assigned officers (spec §29).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;
    const { caseRow } = await assertCaseView(ctx, caseId);

    const rows = await db.caseOfficer.findMany({
      where: { caseId: caseRow.id },
      orderBy: { assignedAt: "asc" },
      include: {
        officer: { select: { id: true, officerId: true, name: true, designation: true, role: true, status: true } },
        department: { select: { id: true, name: true, departmentType: true } },
      },
    });

    return jsonOk({
      items: rows.map((r) => ({
        id: r.id,
        officer: r.officer,
        department: r.department,
        roleOnCase: r.roleOnCase,
        status: r.status,
        assignedAt: r.assignedAt,
        unassignedAt: r.unassignedAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/v1/cases/{caseId}/officers — assign officer (spec §29).
// The officer must be ACTIVE and must belong to a department that is a
// current participant of the case (origin/custodian/participating/consulted).
// The department on the CaseOfficer row is derived from the officer record —
// never from the request body.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_OFFICER_MANAGE);
    const { caseId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_OFFICER_MANAGE);
    assertCaseMutable(caseRow.status, "assign officers");

    const body = await req.json().catch(() => ({}));
    const data = addCaseOfficerSchema.parse(body);

    const officer = await db.officer.findFirst({
      where: { OR: [{ id: data.officerId }, { officerId: data.officerId }] },
      include: { department: { select: { id: true, name: true, status: true } } },
    });
    if (!officer) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Officer not found.");
    if (officer.status !== "ACTIVE" || !AUTH_ALLOWED_STATUSES.includes(officer.status)) {
      throw new ApiError(422, ERROR_CODES.OFFICER_INELIGIBLE, "This officer is inactive and cannot be assigned.");
    }

    const participation = await db.caseDepartment.findFirst({
      where: { caseId: caseRow.id, departmentId: officer.departmentId, status: "ACTIVE" },
    });
    if (!participation) {
      throw new ApiError(
        422,
        ERROR_CODES.OFFICER_INELIGIBLE,
        "The officer's department must be a participant of this case before the officer can be assigned."
      );
    }

    const existing = await db.caseOfficer.findUnique({
      where: { caseId_officerId: { caseId: caseRow.id, officerId: officer.id } },
    });
    if (existing) {
      if (existing.status === "ACTIVE") {
        throw new ApiError(409, ERROR_CODES.CONFLICT, "This officer is already assigned to the case.");
      }
      // Re-activate a previously removed assignment.
      const restored = await db.caseOfficer.update({
        where: { id: existing.id },
        data: {
          status: "ACTIVE",
          roleOnCase: data.roleOnCase,
          assignedAt: new Date(),
          unassignedAt: null,
          assignedByOfficerId: ctx.officer.id,
          note: data.note || null,
        },
      });
      await recordCaseEvent({
        eventType: "CASE_OFFICER_ASSIGNED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "CASE_OFFICER",
        targetId: officer.officerId,
        description: `${officer.name} re-assigned as ${data.roleOnCase.replaceAll("_", " ").toLowerCase()}`,
      });
      return jsonOk(restored, 201);
    }

    const created = await db.caseOfficer.create({
      data: {
        caseId: caseRow.id,
        officerId: officer.id,
        departmentId: officer.departmentId,
        roleOnCase: data.roleOnCase,
        assignedByOfficerId: ctx.officer.id,
        note: data.note || null,
      },
    });

    await recordCaseEvent({
      eventType: "CASE_OFFICER_ASSIGNED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CASE_OFFICER",
      targetId: officer.officerId,
      description: `${officer.name} (${officer.department.name}) assigned as ${data.roleOnCase.replaceAll("_", " ").toLowerCase()}`,
      metadata: { roleOnCase: data.roleOnCase, departmentId: officer.departmentId },
    });

    return jsonOk(created, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
