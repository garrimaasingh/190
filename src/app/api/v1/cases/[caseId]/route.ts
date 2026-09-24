import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateCaseSchema } from "@/lib/validation";
import { resolveCaseAccess, computeCaseAccess, assertCaseManageWithPermission } from "@/lib/cases/access";
import { assertCaseMutable, listAllowedTransitions } from "@/lib/cases/status";
import { recordCaseEvent } from "@/lib/cases/events";
import { ERROR_CODES, CASE_MUTABLE_STATUSES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId} — case dashboard bundle (spec §26/§45).
// Authorization FIRST: unauthorized callers receive 403 and no data —
// nothing is returned-and-hidden.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const { caseId } = await params;

    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    if (!access.view) {
      await recordCaseEvent({
        eventType: "CASE_ACCESS_DENIED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        actorIdentifier: ctx.officer.officerId,
        departmentId: ctx.officer.departmentId,
        description: "Denied case detail access",
      });
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const [originating, custodian, participants, officers, transfers, events, geo] = await Promise.all([
      db.department.findUniqueOrThrow({
        where: { id: caseRow.originatingDepartmentId },
        select: { id: true, departmentCode: true, name: true, departmentType: true },
      }),
      db.department.findUniqueOrThrow({
        where: { id: caseRow.currentCustodianDepartmentId },
        select: { id: true, departmentCode: true, name: true, departmentType: true, logoPath: true },
      }),
      db.caseDepartment.findMany({
        where: { caseId: caseRow.id, status: "ACTIVE" },
        include: {
          department: { select: { id: true, departmentCode: true, name: true, departmentType: true, logoPath: true } },
        },
        orderBy: { joinedAt: "asc" },
      }),
      db.caseOfficer.findMany({
        where: { caseId: caseRow.id },
        include: {
          officer: {
            select: { id: true, officerId: true, name: true, designation: true, role: true, status: true },
          },
          department: { select: { id: true, name: true, departmentType: true } },
        },
        orderBy: { assignedAt: "asc" },
      }),
      db.caseTransfer.findMany({
        where: { caseId: caseRow.id },
        orderBy: { requestedAt: "asc" },
        include: {
          fromDepartment: { select: { id: true, name: true } },
          toDepartment: { select: { id: true, name: true } },
          requestedByOfficer: { select: { officerId: true, name: true } },
          acceptedByOfficer: { select: { officerId: true, name: true } },
          toOfficer: { select: { officerId: true, name: true } },
        },
      }),
      db.caseEvent.findMany({
        where: { caseId: caseRow.id },
        orderBy: { createdAt: "asc" },
        take: 200,
      }),
      db.city.findUniqueOrThrow({
        where: { id: caseRow.cityId },
        select: { name: true, district: { select: { name: true, state: { select: { name: true } } } } },
      }),
    ]);

    // Resolve event actor labels in one query.
    const actorIds = Array.from(
      new Set(events.map((e) => e.actorOfficerId).filter((v): v is string => !!v))
    );
    const actors = actorIds.length
      ? await db.officer.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, officerId: true, name: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const departmentNames = new Map(participants.map((p) => [p.departmentId, p.department.name]));

    const custodianOfficer = caseRow.currentCustodianOfficerId
      ? await db.officer.findUnique({
          where: { id: caseRow.currentCustodianOfficerId },
          select: { id: true, officerId: true, name: true, designation: true },
        })
      : null;

    const creator = await db.officer.findUniqueOrThrow({
      where: { id: caseRow.createdByOfficerId },
      select: { id: true, officerId: true, name: true },
    });

    return jsonOk({
      id: caseRow.id,
      caseId: caseRow.caseId,
      caseNumber: caseRow.caseNumber,
      title: caseRow.title,
      description: caseRow.description,
      caseType: caseRow.caseType,
      caseCategory: caseRow.caseCategory,
      priority: caseRow.priority,
      status: caseRow.status,
      mutable: CASE_MUTABLE_STATUSES.includes(caseRow.status),
      allowedTransitions: listAllowedTransitions(caseRow.status),
      geography: {
        state: geo.district.state.name,
        district: geo.district.name,
        city: geo.name,
      },
      originatingDepartment: originating,
      currentCustodianDepartment: custodian,
      currentCustodianOfficer: custodianOfficer,
      createdByOfficer: creator,
      openedAt: caseRow.openedAt,
      closedAt: caseRow.closedAt,
      archivedAt: caseRow.archivedAt,
      createdAt: caseRow.createdAt,
      updatedAt: caseRow.updatedAt,
      version: caseRow.version,
      participants: participants.map((p) => ({
        id: p.id,
        department: p.department,
        participationType: p.participationType,
        isOrigin: p.departmentId === caseRow.originatingDepartmentId,
        isCustodian: p.departmentId === caseRow.currentCustodianDepartmentId,
        joinedAt: p.joinedAt,
      })),
      officers: officers.map((o) => ({
        id: o.id,
        officer: o.officer,
        department: o.department,
        roleOnCase: o.roleOnCase,
        status: o.status,
        assignedAt: o.assignedAt,
        unassignedAt: o.unassignedAt,
      })),
      transfers,
      timeline: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actor: e.actorOfficerId ? actorMap.get(e.actorOfficerId) ?? null : null,
        actorIdentifier: e.actorIdentifier,
        department: e.departmentId ? departmentNames.get(e.departmentId) ?? null : null,
        description: e.description,
        createdAt: e.createdAt,
      })),
      viewer: computeCaseAccess(ctx, caseRow),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// PATCH /api/v1/cases/{caseId} — update case metadata (spec §26/§59).
export async function PATCH(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_UPDATE);
    const { caseId } = await params;

    const { caseRow } = await assertCaseManageWithPermission(ctx, caseId, PERMISSIONS.CASE_UPDATE);
    assertCaseMutable(caseRow.status, "update case information");

    const body = await req.json().catch(() => ({}));
    const data = updateCaseSchema.parse(body);

    if (data.caseNumber) {
      const dup = await db.case.findFirst({
        where: {
          caseNumber: data.caseNumber,
          createdByDepartmentId: caseRow.createdByDepartmentId,
          id: { not: caseRow.id },
        },
        select: { caseId: true },
      });
      if (dup) {
        throw new ApiError(
          409,
          ERROR_CODES.CONFLICT,
          `Case number "${data.caseNumber}" is already registered by the originating department (${dup.caseId}).`
        );
      }
    }

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.case.updateMany({
        where: { id: caseRow.id, version: caseRow.version },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.caseNumber !== undefined ? { caseNumber: data.caseNumber ?? null } : {}),
          ...(data.description !== undefined ? { description: data.description || null } : {}),
          ...(data.caseCategory !== undefined ? { caseCategory: data.caseCategory || null } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          version: { increment: 1 },
        },
      });
      if (row.count === 0) {
        throw new ApiError(
          409,
          ERROR_CODES.CONCURRENCY_CONFLICT,
          "The case was modified concurrently. Please reload and try again."
        );
      }
      await recordCaseEvent(
        {
          eventType: "CASE_UPDATED",
          caseId: caseRow.id,
          actorOfficerId: ctx.officer.id,
          departmentId: ctx.officer.departmentId,
          targetType: "CASE",
          targetId: caseRow.caseId,
          description: `Case details updated (${Object.keys(data).join(", ")})`,
          metadata: { fields: Object.keys(data) },
        },
        tx
      );
      return tx.case.findUniqueOrThrow({ where: { id: caseRow.id } });
    });

    return jsonOk({
      id: updated.id,
      caseId: updated.caseId,
      title: updated.title,
      description: updated.description,
      caseNumber: updated.caseNumber,
      priority: updated.priority,
      caseCategory: updated.caseCategory,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
