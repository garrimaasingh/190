import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import {
  ERROR_CODES,
  CASE_STATUS_TRANSITIONS,
  CASE_TERMINAL_STATUSES,
  CASE_STATUSES,
  CASE_MUTABLE_STATUSES,
} from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { recordCaseEvent } from "@/lib/cases/events";

// ============================================================
// Case status service (spec §8/§37).
// A dedicated domain layer — controllers never mutate status
// directly. Every transition is validated against the controlled
// lifecycle map and recorded as a CASE_STATUS_CHANGED event.
// ============================================================

export function validateTransition(currentStatus: string, requestedStatus: string): void {
  if (!(CASE_STATUSES as readonly string[]).includes(requestedStatus)) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Unknown case status.");
  }
  if (currentStatus === requestedStatus) {
    throw new ApiError(409, ERROR_CODES.INVALID_STATUS_TRANSITION, "The case is already in this status.");
  }
  const allowed = CASE_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(requestedStatus)) {
    throw new ApiError(
      409,
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      `Transition ${currentStatus} → ${requestedStatus} is not allowed.`
    );
  }
}

export function listAllowedTransitions(currentStatus: string): string[] {
  return CASE_STATUS_TRANSITIONS[currentStatus] || [];
}

export function assertCaseMutable(status: string, action = "modify this case"): void {
  if (CASE_TERMINAL_STATUSES.includes(status)) {
    throw new ApiError(409, ERROR_CODES.CASE_IMMUTABLE, `A ${status.toLowerCase()} case cannot be modified.`);
  }
  void action;
  if (!CASE_MUTABLE_STATUSES.includes(status)) {
    throw new ApiError(409, ERROR_CODES.CASE_IMMUTABLE, `A case in status ${status} cannot be modified.`);
  }
}

export interface StatusChangeResult {
  id: string;
  caseId: string;
  status: string;
  version: number;
  closedAt: Date | null;
  archivedAt: Date | null;
}

/**
 * change_status(caseRef, target, actor)
 * Transactional + optimistic: the guarded update fails safely if the
 * case row changed concurrently (spec §47).
 */
export async function changeStatus(
  caseInternalId: string,
  requestedStatus: string,
  actor: AuthContext
): Promise<StatusChangeResult> {
  const result = await db.$transaction(async (tx) => {
    const caseRow = await tx.case.findUnique({ where: { id: caseInternalId } });
    if (!caseRow) throw new ApiError(404, ERROR_CODES.CASE_NOT_FOUND, "Case not found.");

    validateTransition(caseRow.status, requestedStatus);

    const now = new Date();
    const data: Record<string, unknown> = {
      status: requestedStatus,
      version: { increment: 1 },
    };
    if (requestedStatus === "OPEN" && !caseRow.openedAt) data.openedAt = now;
    if (requestedStatus === "CLOSED") data.closedAt = now;
    if (requestedStatus === "ARCHIVED") data.archivedAt = now;

    // Optimistic guard: only update if version is unchanged.
    const updated = await tx.case.updateMany({
      where: { id: caseRow.id, version: caseRow.version },
      data,
    });
    if (updated.count === 0) {
      throw new ApiError(
        409,
        ERROR_CODES.CONCURRENCY_CONFLICT,
        "The case was modified concurrently. Please reload and try again."
      );
    }

    await recordCaseEvent(
      {
        eventType: "CASE_STATUS_CHANGED",
        caseId: caseRow.id,
        actorOfficerId: actor.officer.id,
        departmentId: actor.officer.departmentId,
        targetType: "CASE",
        targetId: caseRow.caseId,
        description: `Status changed from ${caseRow.status} to ${requestedStatus}`,
        metadata: { from: caseRow.status, to: requestedStatus },
      },
      tx
    );

    return tx.case.findUniqueOrThrow({
      where: { id: caseRow.id },
      select: { id: true, caseId: true, status: true, version: true, closedAt: true, archivedAt: true },
    });
  });
  return result;
}
