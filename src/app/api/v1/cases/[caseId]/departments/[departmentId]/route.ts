import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseManageWithPermission } from "@/lib/cases/access";
import { assertCaseMutable } from "@/lib/cases/status";
import { recordCaseEvent } from "@/lib/cases/events";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// DELETE /api/v1/cases/{caseId}/departments/{departmentId} — remove a
// PARTICIPATING/CONSULTED department (spec §12). The originating department
// and the current custodian can never be removed this way. The row is kept
// with status REMOVED (historical integrity, spec §35).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ caseId: string; departmentId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_DEPARTMENT_MANAGE);
    const { caseId, departmentId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_DEPARTMENT_MANAGE);
    assertCaseMutable(caseRow.status, "remove departments");

    const dept = await db.department.findFirst({
      where: { OR: [{ id: departmentId }, { departmentCode: departmentId }] },
    });
    if (!dept) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Department not found.");

    const record = await db.caseDepartment.findUnique({
      where: { caseId_departmentId: { caseId: caseRow.id, departmentId: dept.id } },
    });
    if (!record || record.status !== "ACTIVE") {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, "This department does not participate in the case.");
    }
    if (record.participationType === "ORIGINATING" || dept.id === caseRow.currentCustodianDepartmentId) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        "The originating department and the current custodian cannot be removed from a case."
      );
    }

    const updated = await db.caseDepartment.update({
      where: { id: record.id },
      data: { status: "REMOVED", leftAt: new Date() },
    });

    // Officers of the removed department lose their case assignments
    // (their department no longer participates).
    const removedAssignments = await db.caseOfficer.updateMany({
      where: { caseId: caseRow.id, departmentId: dept.id, status: "ACTIVE" },
      data: { status: "REMOVED", unassignedAt: new Date() },
    });

    await recordCaseEvent({
      eventType: "CASE_DEPARTMENT_REMOVED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CASE_DEPARTMENT",
      targetId: dept.departmentCode,
      description: `${dept.name} removed from the case${removedAssignments.count > 0 ? ` (${removedAssignments.count} officer assignments revoked)` : ""}`,
    });

    return jsonOk({ id: updated.id, status: updated.status, leftAt: updated.leftAt });
  } catch (err) {
    return handleApiError(err);
  }
}
