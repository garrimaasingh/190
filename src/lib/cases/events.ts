import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { CaseEventType } from "@/lib/constants";

// ============================================================
// Case timeline / audit event interface (spec §24/§25).
// record_event(event_type, actor, department, case, metadata).
//
// Two call modes:
//  - with a transaction client (tx): the event commits atomically
//    with the domain change — used by the custody/status services.
//  - standalone: fire-and-forget (event failure never breaks the
//    primary operation).
//
// Phase 4 may replace the persistence sink (immutable ledger);
// this interface stays stable.
// ============================================================

type DbOrTx = Prisma.TransactionClient | typeof db;

export interface CaseEventInput {
  eventType: CaseEventType;
  caseId: string; // internal Case.id
  actorOfficerId?: string | null;
  actorIdentifier?: string | null;
  departmentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordCaseEvent(input: CaseEventInput, client: DbOrTx = db): Promise<void> {
  const data = {
    eventType: input.eventType,
    caseId: input.caseId,
    actorOfficerId: input.actorOfficerId ?? null,
    actorIdentifier: input.actorIdentifier ?? null,
    departmentId: input.departmentId ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    description: input.description ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  if (client !== db) {
    // Inside a transaction: must commit atomically with the change.
    await client.caseEvent.create({ data });
    return;
  }
  // Fire-and-forget outside transactions.
  try {
    await db.caseEvent.create({ data });
  } catch (err) {
    console.error("[case-event] failed to record", input.eventType, err);
  }
}

// Notification foundation (spec §49): an event-backed abstraction.
// Later phases can subscribe/deliver (in-app, push, email) without
// changing how events are produced.
export interface NotificationPayload {
  type:
    | "TRANSFER_REQUESTED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_REJECTED"
    | "TRANSFER_CANCELLED"
    | "CASE_ASSIGNED";
  caseId: string; // internal id
  publicCaseId: string;
  recipientDepartmentId: string;
  actorOfficerId: string | null;
  metadata?: Record<string, unknown>;
}

export function buildNotification(p: NotificationPayload) {
  // Phase 2: notifications ride on CaseEvent rows; no delivery yet.
  return { ...p, delivered: false as const };
}
