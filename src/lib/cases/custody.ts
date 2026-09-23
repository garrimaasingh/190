import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES, CASE_ACTIVE_LIFECYCLE_STATUSES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { roleHas, PERMISSIONS, type Permission } from "@/lib/permissions";
import { recordCaseEvent, buildNotification } from "@/lib/cases/events";
import { generateTransferId } from "@/lib/cases/ids";
import type { ResolvedGeo } from "@/lib/geo";

// ============================================================
// Case custody service (spec §18-§23/§38/§47).
// Controllers call THIS service — they never touch
// case.currentCustodianDepartmentId directly.
//
// Transfer state machine:
//   REQUESTED → ACCEPTED  (only ACCEPTED changes custody)
//   REQUESTED → REJECTED  (custody unchanged)
//   REQUESTED → CANCELLED (custody unchanged)
//
// Concurrency (spec §47):
//   - accept/reject/cancel are guarded updateMany on status
//   - custody swap is guarded by the case version field
//     (optimistic locking) — stale custody fails safely
//   - one open (REQUESTED) transfer per case at a time
// ============================================================

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function caseGeo(tx: Tx, caseInternalId: string): Promise<ResolvedGeo> {
  const c = await tx.case.findUniqueOrThrow({
    where: { id: caseInternalId },
    select: {
      state: { select: { id: true, name: true, code: true, countryId: true } },
      district: { select: { id: true, name: true, code: true, stateId: true } },
      city: { select: { id: true, name: true, code: true, districtId: true } },
    },
  });
  return {
    country: { id: c.state.countryId, name: "", code: "" },
    state: { ...c.state, countryId: c.state.countryId },
    district: c.district,
    city: c.city,
  };
}

function requirePermission(ctx: AuthContext, permission: Permission, message: string): void {
  if (!roleHas(ctx.officer.role, permission)) {
    throw new ApiError(403, ERROR_CODES.FORBIDDEN, message);
  }
}

async function assertNoPendingTransfer(tx: Tx, caseInternalId: string): Promise<void> {
  const pending = await tx.caseTransfer.findFirst({
    where: { caseId: caseInternalId, status: "REQUESTED" },
    select: { id: true },
  });
  if (pending) {
    throw new ApiError(
      409,
      ERROR_CODES.TRANSFER_ALREADY_PENDING,
      "A custody transfer is already pending for this case. Cancel or resolve it first."
    );
  }
}

// ------------------------------------------------------------------
// TRANSFER REQUEST (spec §18/§21)
// ------------------------------------------------------------------
export interface CreateTransferInput {
  toDepartmentId: string;
  toOfficerId?: string | null;
  reason: string;
  transferNotes?: string | null;
}

export async function createTransferRequest(
  ctx: AuthContext,
  caseInternalId: string,
  input: CreateTransferInput
) {
  requirePermission(
    ctx,
    PERMISSIONS.CASE_TRANSFER_INITIATE,
    "You are not authorized to initiate custody transfers."
  );

  const transfer = await db.$transaction(async (tx) => {
    const caseRow = await tx.case.findUnique({ where: { id: caseInternalId } });
    if (!caseRow) throw new ApiError(404, ERROR_CODES.CASE_NOT_FOUND, "Case not found.");

    // Only the current custodian (dept admin or assigned officer) or the
    // platform administrator can initiate (spec §22 rule 1/2).
    const isCustodian = caseRow.currentCustodianDepartmentId === ctx.officer.departmentId;
    if (!isCustodian && ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(
        403,
        ERROR_CODES.CASE_ACCESS_DENIED,
        "Only the current custodian can initiate this transfer."
      );
    }

    if (!CASE_ACTIVE_LIFECYCLE_STATUSES.includes(caseRow.status)) {
      throw new ApiError(
        409,
        ERROR_CODES.CASE_IMMUTABLE,
        `A ${caseRow.status.toLowerCase()} case cannot be transferred.`
      );
    }

    await assertNoPendingTransfer(tx, caseRow.id);

    // Destination department must exist and be ACTIVE (spec §22 rule 3).
    const destination = await tx.department.findUnique({ where: { id: input.toDepartmentId } });
    if (!destination) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Destination department not found.");
    if (destination.status !== "ACTIVE") {
      throw new ApiError(422, ERROR_CODES.DEPARTMENT_INELIGIBLE, "Destination department is not active.");
    }
    if (destination.id === caseRow.currentCustodianDepartmentId) {
      throw new ApiError(422, ERROR_CODES.DEPARTMENT_INELIGIBLE, "A department cannot transfer a case to itself.");
    }

    // Destination officer, if provided, must be ACTIVE and belong to the
    // destination department (spec §22 rule 4/5). Resolved to the internal
    // id for storage — public ids are lookup keys, never FK values.
    let receivingOfficerId: string | null = null;
    if (input.toOfficerId) {
      const officer = await tx.officer.findFirst({
        where: { OR: [{ id: input.toOfficerId }, { officerId: input.toOfficerId }] },
      });
      if (!officer) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Receiving officer not found.");
      if (officer.departmentId !== destination.id) {
        throw new ApiError(
          422,
          ERROR_CODES.OFFICER_INELIGIBLE,
          "The receiving officer must belong to the destination department."
        );
      }
      if (officer.status !== "ACTIVE") {
        throw new ApiError(422, ERROR_CODES.OFFICER_INELIGIBLE, "The receiving officer is not active.");
      }
      receivingOfficerId = officer.id;
    }

    const year = new Date().getFullYear();
    const geo = await caseGeo(tx, caseRow.id);
    const transferId = await generateTransferId(geo, year);

    const created = await tx.caseTransfer.create({
      data: {
        transferId,
        caseId: caseRow.id,
        fromDepartmentId: caseRow.currentCustodianDepartmentId,
        toDepartmentId: destination.id,
        toOfficerId: receivingOfficerId,
        requestedByOfficerId: ctx.officer.id,
        status: "REQUESTED",
        reason: input.reason,
        transferNotes: input.transferNotes ?? null,
      },
    });

    await recordCaseEvent(
      {
        eventType: "CASE_TRANSFER_REQUESTED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "CASE_TRANSFER",
        targetId: created.transferId,
        description: `Custody transfer requested to ${destination.name}`,
        metadata: {
          transferId: created.transferId,
          toDepartment: destination.name,
          toDepartmentId: destination.id,
        },
      },
      tx
    );

    return created;
  });

  // Notification foundation (spec §49) — event-backed, no delivery yet.
  buildNotification({
    type: "TRANSFER_REQUESTED",
    caseId: transfer.caseId,
    publicCaseId: "",
    recipientDepartmentId: transfer.toDepartmentId,
    actorOfficerId: ctx.officer.id,
  });

  return transfer;
}

// ------------------------------------------------------------------
// ACCEPT / REJECT / CANCEL — shared decision core
// ------------------------------------------------------------------
type DecisionAction = "ACCEPT" | "REJECT" | "CANCEL";

async function loadTransferForDecision(caseInternalId: string, transferRef: string) {
  return db.caseTransfer.findFirst({
    where: { caseId: caseInternalId, OR: [{ transferId: transferRef }, { id: transferRef }] },
  });
}

function authorizeDecision(
  ctx: AuthContext,
  transfer: { fromDepartmentId: string; toDepartmentId: string },
  action: DecisionAction
): void {
  if (ctx.officer.role === "SYSTEM_ADMIN") return; // platform authority
  if (ctx.officer.role === "AUDITOR") {
    throw new ApiError(403, ERROR_CODES.FORBIDDEN, "Auditors cannot act on custody transfers.");
  }
  if (action === "ACCEPT" || action === "REJECT") {
    // Receiving side decides (spec §21).
    if (ctx.officer.departmentId !== transfer.toDepartmentId) {
      throw new ApiError(
        403,
        ERROR_CODES.CASE_ACCESS_DENIED,
        "Only the receiving department can decide this transfer."
      );
    }
    requirePermission(
      ctx,
      PERMISSIONS.CASE_TRANSFER_DECIDE,
      "You are not authorized to decide custody transfers."
    );
  } else {
    // CANCEL: requesting (custodian) side only (spec §22 rule 1).
    if (ctx.officer.departmentId !== transfer.fromDepartmentId) {
      throw new ApiError(
        403,
        ERROR_CODES.CASE_ACCESS_DENIED,
        "Only the requesting department can cancel this transfer."
      );
    }
    requirePermission(
      ctx,
      PERMISSIONS.CASE_TRANSFER_INITIATE,
      "You are not authorized to cancel custody transfers."
    );
  }
}

async function decideTransfer(
  ctx: AuthContext,
  caseInternalId: string,
  transferRef: string,
  action: DecisionAction
) {
  const result = await db.$transaction(async (tx) => {
    const transfer = await loadTransferForDecisionTx(tx, caseInternalId, transferRef);
    if (!transfer) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Transfer not found.");

    authorizeDecision(ctx, transfer, action);

    if (transfer.status !== "REQUESTED") {
      throw new ApiError(
        409,
        ERROR_CODES.INVALID_TRANSFER_STATE,
        `Only requested transfers can be ${action === "ACCEPT" ? "accepted" : action.toLowerCase() + "ed"}.`
      );
    }

    const caseRow = await tx.case.findUnique({ where: { id: caseInternalId } });
    if (!caseRow) throw new ApiError(404, ERROR_CODES.CASE_NOT_FOUND, "Case not found.");

    const now = new Date();
    const statusField =
      action === "ACCEPT" ? "ACCEPTED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
    const stampField =
      action === "ACCEPT" ? "acceptedAt" : action === "REJECT" ? "rejectedAt" : "cancelledAt";

    // Guarded state flip — wins exactly once even under concurrent decisions.
    const decisionData: Record<string, unknown> = {
      status: statusField,
      [stampField]: now,
      updatedAt: now,
    };
    if (action === "ACCEPT") decisionData.acceptedByOfficerId = ctx.officer.id;

    const flipped = await tx.caseTransfer.updateMany({
      where: { id: transfer.id, status: "REQUESTED" },
      data: decisionData,
    });
    if (flipped.count === 0) {
      throw new ApiError(
        409,
        ERROR_CODES.INVALID_TRANSFER_STATE,
        "This transfer has already been decided."
      );
    }

    if (action === "ACCEPT") {
      // Stale-custody guard: the requesting department must STILL be the
      // custodian (spec §22 rule 8 / §47). If another transfer was accepted
      // in the meantime, this one fails safely.
      if (caseRow.currentCustodianDepartmentId !== transfer.fromDepartmentId) {
        throw new ApiError(
          409,
          ERROR_CODES.STALE_CUSTODY_STATE,
          "Custody has changed since this transfer was requested. The request is stale."
        );
      }

      // Optimistic custody swap (spec §47).
      const custodySwap = await tx.case.updateMany({
        where: { id: caseRow.id, version: caseRow.version },
        data: {
          currentCustodianDepartmentId: transfer.toDepartmentId,
          currentCustodianOfficerId: transfer.toOfficerId ?? ctx.officer.id,
          version: { increment: 1 },
        },
      });
      if (custodySwap.count === 0) {
        throw new ApiError(
          409,
          ERROR_CODES.CONCURRENCY_CONFLICT,
          "The case was modified concurrently. Please retry."
        );
      }

      // Participation bookkeeping (spec §12/§21):
      //  - previous custodian → HISTORICAL (origin dept keeps ORIGINATING)
      //  - new custodian → ACTIVE_CUSTODIAN (create or promote row)
      const prev = await tx.caseDepartment.findUnique({
        where: { caseId_departmentId: { caseId: caseRow.id, departmentId: transfer.fromDepartmentId } },
      });
      if (prev) {
        await tx.caseDepartment.update({
          where: { id: prev.id },
          data: { participationType: prev.participationType === "ORIGINATING" ? "ORIGINATING" : "HISTORICAL" },
        });
      }
      await tx.caseDepartment.upsert({
        where: { caseId_departmentId: { caseId: caseRow.id, departmentId: transfer.toDepartmentId } },
        update: { participationType: "ACTIVE_CUSTODIAN", status: "ACTIVE", leftAt: null },
        create: {
          caseId: caseRow.id,
          departmentId: transfer.toDepartmentId,
          participationType: "ACTIVE_CUSTODIAN",
          addedByOfficerId: ctx.officer.id,
        },
      });
    }

    const [fromDept, toDept] = await Promise.all([
      tx.department.findUniqueOrThrow({ where: { id: transfer.fromDepartmentId }, select: { name: true } }),
      tx.department.findUniqueOrThrow({ where: { id: transfer.toDepartmentId }, select: { name: true } }),
    ]);

    await recordCaseEvent(
      {
        eventType:
          action === "ACCEPT"
            ? "CASE_TRANSFER_ACCEPTED"
            : action === "REJECT"
              ? "CASE_TRANSFER_REJECTED"
              : "CASE_TRANSFER_CANCELLED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "CASE_TRANSFER",
        targetId: transfer.transferId,
        description:
          action === "ACCEPT"
            ? `Custody accepted from ${fromDept.name} — ${toDept.name} is now the current custodian`
            : action === "REJECT"
              ? `Custody transfer from ${fromDept.name} to ${toDept.name} was rejected`
              : `Custody transfer to ${toDept.name} was cancelled`,
        metadata: {
          transferId: transfer.transferId,
          fromDepartmentId: transfer.fromDepartmentId,
          toDepartmentId: transfer.toDepartmentId,
        },
      },
      tx
    );

    return tx.caseTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
  });

  return result;
}

function loadTransferForDecisionTx(tx: Tx, caseInternalId: string, transferRef: string) {
  return tx.caseTransfer.findFirst({
    where: { caseId: caseInternalId, OR: [{ transferId: transferRef }, { id: transferRef }] },
  });
}

export async function acceptTransfer(ctx: AuthContext, caseInternalId: string, transferRef: string) {
  return decideTransfer(ctx, caseInternalId, transferRef, "ACCEPT");
}

export async function rejectTransfer(ctx: AuthContext, caseInternalId: string, transferRef: string) {
  return decideTransfer(ctx, caseInternalId, transferRef, "REJECT");
}

export async function cancelTransfer(ctx: AuthContext, caseInternalId: string, transferRef: string) {
  return decideTransfer(ctx, caseInternalId, transferRef, "CANCEL");
}

// ------------------------------------------------------------------
// HISTORY (spec §23) — chronological, never overwritten
// ------------------------------------------------------------------
export async function getCustodyHistory(caseInternalId: string) {
  const transfers = await db.caseTransfer.findMany({
    where: { caseId: caseInternalId },
    orderBy: { requestedAt: "asc" },
    include: {
      fromDepartment: { select: { id: true, name: true, departmentType: true } },
      toDepartment: { select: { id: true, name: true, departmentType: true } },
      requestedByOfficer: { select: { id: true, officerId: true, name: true } },
      acceptedByOfficer: { select: { id: true, officerId: true, name: true } },
      toOfficer: { select: { id: true, officerId: true, name: true } },
    },
  });
  return transfers;
}

export async function getIncomingTransfers(ctx: AuthContext) {
  // Incoming mailbox for the destination department (spec §21).
  return db.caseTransfer.findMany({
    where: { toDepartmentId: ctx.officer.departmentId, status: "REQUESTED" },
    orderBy: { requestedAt: "desc" },
    include: {
      case: { select: { caseId: true, title: true, status: true, priority: true, caseType: true } },
      fromDepartment: { select: { id: true, name: true, departmentType: true } },
      requestedByOfficer: { select: { officerId: true, name: true } },
    },
  });
}
