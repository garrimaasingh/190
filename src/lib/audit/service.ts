import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { hashAuditEvent, AUDIT_GENESIS_HASH } from "@/lib/audit/canonical";

// ============================================================
// AuditService — the ONLY writer of AuditEvent rows (spec §25/§48/
// §49/§53/§54).
//
// APPEND-ONLY: events are created, never updated or deleted.
// Corrections are new events (spec §24).
//
// CHAIN: each event's previousEventHash is the persisted chain head
// (AuditChainState); the new eventHash becomes the new head. Both
// the event insert and the head update happen in ONE transaction,
// so business operations that must be atomic with their audit
// record (spec §48/§49) simply call appendAuditEvent inside their
// own transaction — if the audit write fails, the operation rolls
// back; if the operation fails, no audit event exists for it.
//
// CONCURRENCY (spec §54): sequence numbers are allocated inside the
// transaction from the persisted chain state; AuditEvent.sequence
// is UNIQUE, so a racing writer fails with P2002 and retries with
// the fresh head. SQLite's single-writer locking serializes the
// transactions themselves; the unique constraint is the invariant
// that makes the retry path provably safe. (PostgreSQL production
// note: add SELECT ... FOR UPDATE on the state row — the retry
// path already covers the race.)
//
// FAIL-SAFE POLICY (spec §48):
//   - High-integrity mutations (evidence register/transfer/status,
//     relationships, ledger anchors) call this INSIDE their
//     transaction → audit failure aborts the operation.
//   - Read-path events (viewed/downloaded/searched) are recorded
//     via recordAuditEvent() — best-effort with console alarm, an
//     availability choice; access ENFORCEMENT never depends on it.
//   - ACCESS_DENIED events are always awaited before the denial is
//     returned (best-effort insert, but never skipped).
// ============================================================

type DbOrTx = Prisma.TransactionClient | typeof db;
type Tx = Prisma.TransactionClient;

export type AuditResult = "SUCCESS" | "DENIED" | "FAILED";

export interface AuditEventInput {
  eventType: string;
  actorOfficerId?: string | null;
  actorIdentifier?: string | null; // attempted identity when no resolved actor exists
  actorDepartmentId?: string | null;
  caseId?: string | null; // PUBLIC case id (CASE-…)
  documentId?: string | null; // PUBLIC doc id (DOC-…)
  evidenceId?: string | null; // PUBLIC evidence id (EVD-…)
  sessionId?: string | null;
  result?: AuditResult;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Event occurrence time — defaults to now; testable. */
  timestamp?: Date;
}

/** Metadata hygiene (spec §23/§50): reject anything secret-shaped. */
const FORBIDDEN_METADATA_KEYS = /^(password|token|secret|key|authorization|cookie|content|binary)/i;

/**
 * Public metadata hygiene helper (also exercised by tests): drops
 * secret-shaped keys and bounds string values. Returns the clean
 * object (null when nothing remains).
 */
export function sanitizeClientMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.test(k)) continue; // silently dropped, never stored
    clean[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  return Object.keys(clean).length ? clean : null;
}

function serializeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  const clean = sanitizeClientMetadata(metadata);
  return clean ? JSON.stringify(clean) : null;
}

async function getOrCreateChainState(tx: Tx) {
  const existing = await tx.auditChainState.findUnique({ where: { id: "SINGLETON" } });
  if (existing) return existing;
  return tx.auditChainState.create({
    data: { id: "SINGLETON", lastSequence: 0, lastEventHash: AUDIT_GENESIS_HASH, eventCount: 0 },
  });
}

/**
 * Append one event to the hash chain. Runs inside the caller's
 * transaction when one is provided (atomic with the business
 * operation — spec §49), otherwise in its own transaction.
 * Retries on unique-conflict so concurrent writers serialize.
 */
export async function appendAuditEvent(input: AuditEventInput, client?: DbOrTx): Promise<{
  id: string;
  sequence: number;
  eventId: string;
  eventHash: string;
  previousEventHash: string;
}> {
  const metadata = serializeMetadata(input.metadata);

  const attempt = async (tx: Prisma.TransactionClient) => {
    const state = await getOrCreateChainState(tx);
    const sequence = state.lastSequence + 1;
    const previousEventHash = state.lastEventHash || AUDIT_GENESIS_HASH;
    const timestamp = input.timestamp ?? new Date();
    const eventId = `EVT-${timestamp.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;

    const eventHash = hashAuditEvent({
      eventId,
      sequence,
      eventType: input.eventType,
      actorOfficerId: input.actorOfficerId ?? null,
      actorDepartmentId: input.actorDepartmentId ?? null,
      caseId: input.caseId ?? null,
      documentId: input.documentId ?? null,
      evidenceId: input.evidenceId ?? null,
      sessionId: input.sessionId ?? null,
      timestamp,
      result: input.result ?? "SUCCESS",
      metadata,
      previousEventHash,
    });

    const created = await tx.auditEvent.create({
      data: {
        sequence,
        eventId,
        eventType: input.eventType,
        actorOfficerId: input.actorOfficerId ?? null,
        actorIdentifier: input.actorIdentifier ?? null,
        actorDepartmentId: input.actorDepartmentId ?? null,
        caseId: input.caseId ?? null,
        documentId: input.documentId ?? null,
        evidenceId: input.evidenceId ?? null,
        sessionId: input.sessionId ?? null,
        timestamp,
        result: input.result ?? "SUCCESS",
        ipAddress: input.ipAddress ? input.ipAddress.slice(0, 64) : null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 250) : null,
        deviceId: input.deviceId ? input.deviceId.slice(0, 100) : null,
        metadata,
        previousEventHash,
        eventHash,
        ledgerStatus: "UNANCHORED",
      } as Prisma.AuditEventUncheckedCreateInput,
      select: { id: true, sequence: true, eventId: true, eventHash: true, previousEventHash: true },
    });

    await tx.auditChainState.update({
      where: { id: "SINGLETON" },
      data: {
        lastSequence: sequence,
        lastEventHash: eventHash,
        lastEventId: eventId,
        eventCount: { increment: 1 },
      },
    });

    return created;
  };

  // Embedded mode: the caller's transaction provides atomicity with
  // the business operation (spec §49). A failure here rolls back
  // everything — exactly the fail-safe behavior of spec §48.
  if (client && client !== db) return attempt(client as Tx);

  // Standalone mode with bounded retry for concurrent writers.
  let lastError: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await db.$transaction(attempt);
    } catch (err) {
      const isUniqueConflict =
        typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002";
      if (!isUniqueConflict) throw err;
      lastError = err;
    }
  }
  console.error("[audit] append failed after retries — chain write contention", lastError);
  throw lastError instanceof Error ? lastError : new Error("AUDIT_APPEND_FAILED");
}

/**
 * Best-effort audit for read paths (spec §48 policy, see header).
 * Never throws — a failed view-audit is logged loudly instead.
 */
export async function recordAuditEvent(input: AuditEventInput, client?: DbOrTx): Promise<void> {
  try {
    await appendAuditEvent(input, client);
  } catch (err) {
    // AUDIT-EVENT-CREATION-FAILURE observability hook (spec §71).
    console.error("[audit] FAILED to record audit event", input.eventType, err);
  }
}
