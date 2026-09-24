import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import { CASE_ACTIVE_LIFECYCLE_STATUSES } from "@/lib/constants";
import { appendAuditEvent } from "@/lib/audit/service";
import { recordCaseEvent } from "@/lib/cases/events";
import { generateEvidenceTransferId } from "@/lib/cases/ids";

// ============================================================
// EvidenceCustodyService (spec §15/§16/§17/§18/§44/§45).
//
// The ONLY writer of Evidence.currentCustodian* fields (spec §17):
//   Transfer Request → Authorization → Receiving Party → Accept
//     → Custody Event → Current Custodian Updated
// every step inside transactions with the audit events they must
// produce (spec §48/§49). REJECT/CANCEL leave custody untouched.
//
// §44 RULES ENFORCED:
//  1. only the current custodian (or platform admin) initiates
//  2. destination must be a valid, ACTIVE department
//  3. destination officer (if given) must be ACTIVE and belong to it
//  4. destination department must participate in the case
//  5. self-transfer prohibited
//  6. only REQUESTED transfers can be decided
//  7. acceptance changes current custodian
//  8. rejection leaves custody unchanged
//  9. decided transfers are historical — no API mutates them (and
//     SQLite guards abort direct UPDATEs of decided rows)
// 10. every transition writes audit events
//
// §45: evidence custody is INDEPENDENT of case custody — nothing
// here touches CaseDepartment/Case custodian fields, and a case
// custody transfer never moves evidence.
// ============================================================

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function caseGeo(tx: Tx, caseInternalId: string) {
  const c = await tx.case.findUniqueOrThrow({
    where: { id: caseInternalId },
    select: { state: { select: { code: true } }, district: { select: { code: true } } },
  });
  return { state: { code: c.state.code }, district: { code: c.district.code } };
}

function requirePermission(ctx: AuthContext, permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS], message: string): void {
  if (!roleHas(ctx.officer.role, permission)) {
    throw new ApiError(403, "FORBIDDEN", message);
  }
}

// ------------------------------------------------------------------
// TRANSFER REQUEST (spec §16/§44)
// ------------------------------------------------------------------
export interface CreateEvidenceTransferInput {
  toDepartmentId: string;
  toOfficerId?: string | null;
  reason: string;
  notes?: string | null;
}

export async function createEvidenceTransferRequest(params: {
  ctx: AuthContext;
  caseRow: { id: string; caseId: string; status: string };
  evidence: { id: string; evidenceId: string; title: string; status: string; currentCustodianDepartmentId: string | null };
  input: CreateEvidenceTransferInput;
}) {
  const { ctx, caseRow, evidence, input } = params;
  requirePermission(
    ctx,
    PERMISSIONS.EVIDENCE_TRANSFER_INITIATE,
    "You are not authorized to initiate evidence custody transfers."
  );

  return db.$transaction(async (tx) => {
    const item = await tx.evidence.findUnique({ where: { id: evidence.id } });
    if (!item) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");

    // Rule 1: only the current custodian (or platform admin) initiates.
    const isCustodian = item.currentCustodianDepartmentId === ctx.officer.departmentId;
    if (!isCustodian && ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "Only the current custodian can initiate this transfer.");
    }
    // Rule 6-guard: an item already pending a transfer cannot start another.
    if (item.status === "TRANSFER_PENDING") {
      throw new ApiError(409, "TRANSFER_ALREADY_PENDING", "A custody transfer is already pending for this evidence.");
    }
    if (["ARCHIVED", "RETURNED", "RELEASED"].includes(item.status)) {
      throw new ApiError(409, "INVALID_EVIDENCE_STATE", `Evidence in status ${item.status} cannot be transferred.`);
    }
    if (!CASE_ACTIVE_LIFECYCLE_STATUSES.includes(caseRow.status)) {
      throw new ApiError(409, "CASE_IMMUTABLE", `A ${caseRow.status.toLowerCase()} case cannot transfer evidence.`);
    }

    // Rule 2: destination must exist and be ACTIVE.
    const destination = await tx.department.findUnique({ where: { id: input.toDepartmentId } });
    if (!destination) throw new ApiError(404, "NOT_FOUND", "Destination department not found.");
    if (destination.status !== "ACTIVE") {
      throw new ApiError(422, "DEPARTMENT_INELIGIBLE", "Destination department is not active.");
    }
    // Rule 5: self-transfer prohibited.
    if (destination.id === item.currentCustodianDepartmentId) {
      throw new ApiError(422, "DEPARTMENT_INELIGIBLE", "Evidence cannot be transferred to its current custodian.");
    }
    // Rule 4: destination must participate in the case.
    const participation = await tx.caseDepartment.findFirst({
      where: { caseId: caseRow.id, departmentId: destination.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (!participation) {
      throw new ApiError(422, "DEPARTMENT_INELIGIBLE", "The destination department must be a participant of the case.");
    }

    // Rule 3: destination officer active + belongs to the destination.
    let receivingOfficerId: string | null = null;
    if (input.toOfficerId) {
      const officer = await tx.officer.findFirst({
        where: { OR: [{ id: input.toOfficerId }, { officerId: input.toOfficerId }] },
      });
      if (!officer) throw new ApiError(404, "NOT_FOUND", "Receiving officer not found.");
      if (officer.departmentId !== destination.id) {
        throw new ApiError(422, "OFFICER_INELIGIBLE", "The receiving officer must belong to the destination department.");
      }
      if (officer.status !== "ACTIVE") {
        throw new ApiError(422, "OFFICER_INELIGIBLE", "The receiving officer is not active.");
      }
      receivingOfficerId = officer.id;
    }

    const geo = await caseGeo(tx, caseRow.id);
    const transferId = await generateEvidenceTransferId(geo, new Date().getFullYear());

    const created = await tx.evidenceTransfer.create({
      data: {
        transferId,
        evidenceId: item.id,
        caseId: caseRow.id,
        fromDepartmentId: item.currentCustodianDepartmentId!,
        toDepartmentId: destination.id,
        toOfficerId: receivingOfficerId,
        requestedByOfficerId: ctx.officer.id,
        status: "REQUESTED",
        reason: input.reason,
        notes: input.notes ?? null,
        previousItemStatus: item.status, // restored on reject/cancel
      },
    });

    // Custody service owns the TRANSFER_PENDING flip (spec §17).
    const flipped = await tx.evidence.updateMany({
      where: { id: item.id, status: item.status, version: item.version },
      data: { status: "TRANSFER_PENDING", version: { increment: 1 } },
    });
    if (flipped.count === 0) {
      throw new ApiError(409, "CONCURRENCY_CONFLICT", "Evidence was modified concurrently. Please retry.");
    }

    // Rule 10 + §49: audit events in the SAME transaction.
    await appendAuditEvent(
      {
        eventType: "EVIDENCE_TRANSFER_REQUESTED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: item.evidenceId,
        sessionId: ctx.sessionId,
        metadata: { transferId, toDepartment: destination.name, toDepartmentId: destination.id, reason: input.reason.slice(0, 200) },
      },
      tx
    );

    await recordCaseEvent(
      {
        eventType: "EVIDENCE_CUSTODY_CHANGED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "EVIDENCE_TRANSFER",
        targetId: transferId,
        description: `Evidence custody transfer requested: ${item.evidenceId} → ${destination.name}`,
        metadata: { transferId, evidenceId: item.evidenceId, toDepartment: destination.name },
      },
      tx
    );

    return created;
  });
}

// ------------------------------------------------------------------
// DECIDE: ACCEPT / REJECT / CANCEL (spec §16/§17/§44 rules 6-10)
// ------------------------------------------------------------------
type DecisionAction = "ACCEPT" | "REJECT" | "CANCEL";

export async function decideEvidenceTransfer(params: {
  ctx: AuthContext;
  transferRef: string;
  action: DecisionAction;
}) {
  const { ctx, transferRef, action } = params;

  if (action === "ACCEPT" || action === "REJECT") {
    requirePermission(
      ctx,
      PERMISSIONS.EVIDENCE_TRANSFER_DECIDE,
      "You are not authorized to decide evidence custody transfers."
    );
  } else {
    requirePermission(
      ctx,
      PERMISSIONS.EVIDENCE_TRANSFER_INITIATE,
      "You are not authorized to cancel evidence custody transfers."
    );
  }

  return db.$transaction(async (tx) => {
    const transfer = await tx.evidenceTransfer.findFirst({
      where: { OR: [{ transferId: transferRef }, { id: transferRef }] },
    });
    if (!transfer) throw new ApiError(404, "NOT_FOUND", "Transfer not found.");

    // Authorization: receiving side decides accept/reject; requesting
    // (custodian) side cancels; platform admin overrides (spec §44 rule 1).
    if (ctx.officer.role !== "SYSTEM_ADMIN") {
      if (ctx.officer.role === "AUDITOR") {
        throw new ApiError(403, "FORBIDDEN", "Auditors cannot act on custody transfers.");
      }
      if (action === "CANCEL") {
        if (ctx.officer.departmentId !== transfer.fromDepartmentId) {
          throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "Only the requesting department can cancel this transfer.");
        }
      } else if (ctx.officer.departmentId !== transfer.toDepartmentId) {
        throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "Only the receiving department can decide this transfer.");
      }
    }

    if (transfer.status !== "REQUESTED") {
      // Rule 6/9: decided transfers are immutable history.
      throw new ApiError(409, "INVALID_TRANSFER_STATE", `This transfer has already been ${transfer.status.toLowerCase()}.`);
    }

    const item = await tx.evidence.findUnique({ where: { id: transfer.evidenceId } });
    if (!item) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");

    // Stale-custody guard: the requesting department must STILL hold custody.
    if (item.currentCustodianDepartmentId !== transfer.fromDepartmentId) {
      throw new ApiError(409, "STALE_CUSTODY_STATE", "Custody has changed since this transfer was requested. The request is stale.");
    }

    const now = new Date();
    const statusField = action === "ACCEPT" ? "ACCEPTED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
    const stampField = action === "ACCEPT" ? "acceptedAt" : action === "REJECT" ? "rejectedAt" : "cancelledAt";

    // Guarded state flip — wins exactly once even under concurrent decisions.
    const decisionData: Record<string, unknown> = { status: statusField, [stampField]: now, updatedAt: now };
    if (action === "ACCEPT") decisionData.acceptedByOfficerId = ctx.officer.id;
    const flipped = await tx.evidenceTransfer.updateMany({
      where: { id: transfer.id, status: "REQUESTED" },
      data: decisionData,
    });
    if (flipped.count === 0) {
      throw new ApiError(409, "INVALID_TRANSFER_STATE", "This transfer has already been decided.");
    }

    if (action === "ACCEPT") {
      // §17 custody swap — guarded by evidence version (optimistic lock).
      const custodySwap = await tx.evidence.updateMany({
        where: { id: item.id, status: "TRANSFER_PENDING", version: item.version },
        data: {
          currentCustodianDepartmentId: transfer.toDepartmentId,
          currentCustodianOfficerId: transfer.toOfficerId ?? ctx.officer.id,
          status: "TRANSFERRED",
          version: { increment: 1 },
        },
      });
      if (custodySwap.count === 0) {
        throw new ApiError(409, "CONCURRENCY_CONFLICT", "Evidence was modified concurrently. Please retry.");
      }
    } else {
      // Rule 8: reject/cancel leave custody unchanged — restore status.
      const restoreStatus = transfer.previousItemStatus && transfer.previousItemStatus !== "TRANSFER_PENDING"
        ? transfer.previousItemStatus
        : "IN_CUSTODY";
      await tx.evidence.updateMany({
        where: { id: item.id, status: "TRANSFER_PENDING", version: item.version },
        data: { status: restoreStatus, version: { increment: 1 } },
      });
    }

    const [fromDept, toDept] = await Promise.all([
      tx.department.findUniqueOrThrow({ where: { id: transfer.fromDepartmentId }, select: { name: true } }),
      tx.department.findUniqueOrThrow({ where: { id: transfer.toDepartmentId }, select: { name: true } }),
    ]);

    // Rule 10 + §49: audit in the same transaction as the custody change.
    await appendAuditEvent(
      {
        eventType:
          action === "ACCEPT"
            ? "EVIDENCE_TRANSFER_ACCEPTED"
            : action === "REJECT"
              ? "EVIDENCE_TRANSFER_REJECTED"
              : "EVIDENCE_TRANSFER_CANCELLED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: transfer.caseId,
        evidenceId: item.evidenceId,
        sessionId: ctx.sessionId,
        metadata: {
          transferId: transfer.transferId,
          fromDepartment: fromDept.name,
          toDepartment: toDept.name,
        },
      },
      tx
    );

    await recordCaseEvent(
      {
        eventType: "EVIDENCE_CUSTODY_CHANGED",
        caseId: transfer.caseId,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "EVIDENCE_TRANSFER",
        targetId: transfer.transferId,
        description:
          action === "ACCEPT"
            ? `Evidence custody accepted: ${item.evidenceId} now held by ${toDept.name}`
            : action === "REJECT"
              ? `Evidence custody transfer to ${toDept.name} was rejected`
              : `Evidence custody transfer to ${toDept.name} was cancelled`,
        metadata: { transferId: transfer.transferId, evidenceId: item.evidenceId, action },
      },
      tx
    );

    return tx.evidenceTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
  });
}

// ------------------------------------------------------------------
// CUSTODY HISTORY (spec §18) — chronological, includes the initial
// collection record derived from frozen registration metadata.
// Never overwritten; corrections are new events.
// ------------------------------------------------------------------
export async function getEvidenceCustodyChain(evidenceInternalId: string) {
  const item = await db.evidence.findUnique({
    where: { id: evidenceInternalId },
    select: {
      evidenceId: true,
      collectedAt: true,
      collectionLocation: true,
      collectedByOfficer: { select: { officerId: true, name: true } },
      collectingDepartment: { select: { id: true, name: true, departmentType: true } },
      currentCustodianDepartment: { select: { id: true, name: true, departmentType: true } },
      currentCustodianOfficer: { select: { officerId: true, name: true } },
      status: true,
    },
  });
  if (!item) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");

  const transfers = await db.evidenceTransfer.findMany({
    where: { evidenceId: evidenceInternalId },
    orderBy: { requestedAt: "asc" },
    include: {
      fromDepartment: { select: { id: true, name: true, departmentType: true } },
      toDepartment: { select: { id: true, name: true, departmentType: true } },
      requestedByOfficer: { select: { officerId: true, name: true } },
      acceptedByOfficer: { select: { officerId: true, name: true } },
      toOfficer: { select: { officerId: true, name: true } },
    },
  });

  // Chain = COLLECTED (from frozen acquisition metadata) + transfer records.
  const chain: Array<{
    kind: "COLLECTED" | "TRANSFER";
    timestamp: Date;
    actorDepartment: string | null;
    actorOfficer: string | null;
    action: string;
    status: string;
    fromDepartment: string | null;
    toDepartment: string | null;
    detail: Record<string, unknown> | null;
  }> = [
    {
      kind: "COLLECTED",
      timestamp: item.collectedAt ?? new Date(0),
      actorDepartment: item.collectingDepartment?.name ?? null,
      actorOfficer: item.collectedByOfficer?.name ?? null,
      action: item.collectedAt ? "COLLECTED" : "REGISTERED",
      status: "RECORDED",
      fromDepartment: null,
      toDepartment: item.collectingDepartment?.name ?? null,
      detail: item.collectionLocation ? { location: item.collectionLocation } : null,
    },
  ];

  for (const t of transfers) {
    chain.push({
      kind: "TRANSFER",
      timestamp: t.acceptedAt ?? t.rejectedAt ?? t.cancelledAt ?? t.requestedAt,
      actorDepartment: t.toDepartment.name,
      actorOfficer: (t.acceptedByOfficer ?? t.requestedByOfficer)?.name ?? null,
      action: t.status,
      status: t.status,
      fromDepartment: t.fromDepartment.name,
      toDepartment: t.toDepartment.name,
      detail: { transferId: t.transferId, reason: t.reason, requestedBy: t.requestedByOfficer.name },
    });
  }

  return {
    evidenceId: item.evidenceId,
    currentCustodian: item.currentCustodianDepartment
      ? { department: item.currentCustodianDepartment.name, officer: item.currentCustodianOfficer?.name ?? null }
      : null,
    status: item.status,
    chain,
    transfers,
  };
}

export async function getIncomingEvidenceTransfers(ctx: AuthContext) {
  return db.evidenceTransfer.findMany({
    where: { toDepartmentId: ctx.officer.departmentId, status: "REQUESTED" },
    orderBy: { requestedAt: "desc" },
    include: {
      evidence: { select: { evidenceId: true, title: true, classification: true, evidenceType: true } },
      case: { select: { caseId: true, title: true } },
      fromDepartment: { select: { id: true, name: true, departmentType: true } },
      requestedByOfficer: { select: { officerId: true, name: true } },
    },
  });
}
