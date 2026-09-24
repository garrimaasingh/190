import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateCaseOfficerSchema } from "@/lib/validation";
import { assertCaseManageWithPermission } from "@/lib/cases/access";
import { assertCaseMutable } from "@/lib/cases/status";
import { recordCaseEvent } from "@/lib/cases/events";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

async function loadRecord(caseInternalId: string, officerRecordId: string) {
  return db.caseOfficer.findFirst({
    where: {
      caseId: caseInternalId,
      OR: [{ id: officerRecordId }, { officerId: officerRecordId }],
    },
    include: {
      officer: { select: { id: true, officerId: true, name: true } },
    },
  });
}

// PATCH /api/v1/cases/{caseId}/officers/{officerId} — change case role.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ caseId: string; officerRecordId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_OFFICER_MANAGE);
    const { caseId, officerRecordId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_OFFICER_MANAGE);
    assertCaseMutable(caseRow.status, "modify case officers");

    const record = await loadRecord(caseRow.id, officerRecordId);
    if (!record || record.status !== "ACTIVE") {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Assigned officer not found.");
    }

    const body = await req.json().catch(() => ({}));
    const data = updateCaseOfficerSchema.parse(body);
    if (!data.roleOnCase) throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Nothing to update.");

    const updated = await db.caseOfficer.update({
      where: { id: record.id },
      data: { roleOnCase: data.roleOnCase },
    });

    await recordCaseEvent({
      eventType: "CASE_UPDATED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CASE_OFFICER",
      targetId: record.officer.officerId,
      description: `${record.officer.name}'s case role changed to ${data.roleOnCase.replaceAll("_", " ").toLowerCase()}`,
      metadata: { roleOnCase: data.roleOnCase },
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/v1/cases/{caseId}/officers/{officerId} — unassign officer.
// Historical record is retained with status REMOVED (spec §35).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ caseId: string; officerRecordId: string }> }
) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_OFFICER_MANAGE);
    const { caseId, officerRecordId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_OFFICER_MANAGE);
    assertCaseMutable(caseRow.status, "remove case officers");

    const record = await loadRecord(caseRow.id, officerRecordId);
    if (!record || record.status !== "ACTIVE") {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Assigned officer not found.");
    }

    const updated = await db.caseOfficer.update({
      where: { id: record.id },
      data: { status: "REMOVED", unassignedAt: new Date() },
    });

    await recordCaseEvent({
      eventType: "CASE_OFFICER_UNASSIGNED",
      caseId: caseRow.id,
      actorOfficerId: ctx.officer.id,
      departmentId: ctx.officer.departmentId,
      targetType: "CASE_OFFICER",
      targetId: record.officer.officerId,
      description: `${record.officer.name} removed from the case`,
    });

    return jsonOk({ id: updated.id, status: updated.status, unassignedAt: updated.unassignedAt });
  } catch (err) {
    return handleApiError(err);
  }
}
