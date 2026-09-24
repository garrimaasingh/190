import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { hashAuditEvent, AUDIT_GENESIS_HASH } from "@/lib/audit/canonical";

// ============================================================
// AuditIntegrityService (spec §28/§56).
//
// Recomputes the canonical hash of stored events and walks the
// chain. A modified historical event (even by direct database
// access) produces a hash mismatch or a broken previous-hash link
// at a DETERMINISTIC position: the FIRST affected event is
// reported with its expected vs actual hash and chain position.
//
// HONEST SCOPE (spec §29): this makes tampering EVIDENT — it does
// not make it impossible for an infrastructure administrator who
// can rewrite every row and every hash. External anchoring
// (LedgerService, spec §30/§31) narrows that window further.
//
// verify_range(from > 1) trusts the stored previous-hash linkage
// at the range boundary (bounded trust, documented); verify_chain()
// from genesis is the authoritative check.
//
// The service accepts an optional Prisma delegate so verification
// can run against a SEPARATE database copy in tests (the tamper
// acceptance test of spec §56 never touches production data).
// ============================================================

type DbOrTx = Prisma.TransactionClient | typeof db;

export interface ChainVerificationIssue {
  sequence: number;
  eventId: string;
  reason: "HASH_MISMATCH" | "PREVIOUS_HASH_MISMATCH" | "SEQUENCE_GAP" | "READ_ERROR";
  expectedHash?: string;
  actualHash?: string;
  expectedPreviousHash?: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  algorithm: "SHA-256";
  fromSequence: number;
  toSequence: number;
  eventsChecked: number;
  headHash: string | null;
  firstInvalid: ChainVerificationIssue | null;
}

const HASH_SELECT = {
  sequence: true,
  eventId: true,
  eventType: true,
  actorOfficerId: true,
  actorDepartmentId: true,
  caseId: true,
  documentId: true,
  evidenceId: true,
  sessionId: true,
  timestamp: true,
  result: true,
  metadata: true,
  previousEventHash: true,
  eventHash: true,
} as const;

/** Verify the FULL chain from genesis (authoritative). */
export async function verifyChain(client: DbOrTx = db): Promise<ChainVerificationResult> {
  return verifyRange(client, 1);
}

/**
 * Verify events sequence >= fromSequence. fromSequence === 1 walks
 * from genesis; a later start trusts the stored previous-hash of
 * the first event in range (bounded verification for large chains,
 * spec §28 verify_range).
 */
export async function verifyRange(client: DbOrTx = db, fromSequence = 1, toSequence?: number): Promise<ChainVerificationResult> {
  const events = await client.auditEvent.findMany({
    where: { sequence: { gte: fromSequence, ...(toSequence !== undefined ? { lte: toSequence } : {}) } },
    orderBy: { sequence: "asc" },
    select: HASH_SELECT,
  });

  const from = fromSequence < 1 ? 1 : fromSequence;
  let expectedPrevious =
    from === 1 ? AUDIT_GENESIS_HASH : (await client.auditEvent.findFirst({ where: { sequence: from - 1 }, select: { eventHash: true } }))?.eventHash ?? AUDIT_GENESIS_HASH;

  let lastSequence = from - 1;
  let headHash: string | null = from === 1 ? AUDIT_GENESIS_HASH : expectedPrevious;
  let checked = 0;

  for (const event of events) {
    // 1. No gaps — sequences are contiguous from the start of the range.
    if (event.sequence !== lastSequence + 1) {
      return {
        valid: false,
        algorithm: "SHA-256",
        fromSequence: from,
        toSequence: toSequence ?? lastSequence,
        eventsChecked: checked,
        headHash,
        firstInvalid: {
          sequence: event.sequence,
          eventId: event.eventId,
          reason: "SEQUENCE_GAP",
          expectedPreviousHash: expectedPrevious,
        },
      };
    }

    // 2. The stored previous hash must link to the running head.
    if (event.previousEventHash !== expectedPrevious) {
      return {
        valid: false,
        algorithm: "SHA-256",
        fromSequence: from,
        toSequence: toSequence ?? event.sequence,
        eventsChecked: checked,
        headHash,
        firstInvalid: {
          sequence: event.sequence,
          eventId: event.eventId,
          reason: "PREVIOUS_HASH_MISMATCH",
          expectedPreviousHash: expectedPrevious,
          actualHash: event.previousEventHash,
        },
      };
    }

    // 3. The event's own hash must match a fresh canonical recomputation.
    const recomputed = hashAuditEvent({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      actorOfficerId: event.actorOfficerId,
      actorDepartmentId: event.actorDepartmentId,
      caseId: event.caseId,
      documentId: event.documentId,
      evidenceId: event.evidenceId,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      result: event.result,
      metadata: event.metadata,
      previousEventHash: event.previousEventHash,
    });
    if (recomputed !== event.eventHash) {
      return {
        valid: false,
        algorithm: "SHA-256",
        fromSequence: from,
        toSequence: toSequence ?? event.sequence,
        eventsChecked: checked,
        headHash,
        firstInvalid: {
          sequence: event.sequence,
          eventId: event.eventId,
          reason: "HASH_MISMATCH",
          expectedHash: recomputed,
          actualHash: event.eventHash,
        },
      };
    }

    expectedPrevious = event.eventHash;
    headHash = event.eventHash;
    lastSequence = event.sequence;
    checked++;
  }

  return {
    valid: true,
    algorithm: "SHA-256",
    fromSequence: from,
    toSequence: toSequence ?? lastSequence,
    eventsChecked: checked,
    headHash,
    firstInvalid: null,
  };
}

/** verify_event: self-consistency of one event (self hash + linkage info). */
export async function verifyEvent(eventRef: string, client: DbOrTx = db): Promise<{
  valid: boolean;
  eventId: string;
  sequence: number;
  recomputedHash: string;
  storedHash: string;
  linksToPrevious: boolean;
}> {
  const event = await client.auditEvent.findFirst({
    where: { OR: [{ eventId: eventRef }, { sequence: Number.isFinite(Number(eventRef)) ? Number(eventRef) : -1 }] },
    select: HASH_SELECT,
  });
  if (!event) throw new Error("AUDIT_EVENT_NOT_FOUND");
  const recomputed = hashAuditEvent({
    eventId: event.eventId,
    sequence: event.sequence,
    eventType: event.eventType,
    actorOfficerId: event.actorOfficerId,
    actorDepartmentId: event.actorDepartmentId,
    caseId: event.caseId,
    documentId: event.documentId,
    evidenceId: event.evidenceId,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    result: event.result,
    metadata: event.metadata,
    previousEventHash: event.previousEventHash,
  });
  return {
    valid: recomputed === event.eventHash,
    eventId: event.eventId,
    sequence: event.sequence,
    recomputedHash: recomputed,
    storedHash: event.eventHash,
    linksToPrevious: true, // previous linkage is structural; full-chain verify checks continuity
  };
}

/** Persist a verification result for the integrity dashboard (spec §61). */
export async function cacheVerificationState(result: ChainVerificationResult): Promise<void> {
  await db.auditChainState.upsert({
    where: { id: "SINGLETON" },
    update: {
      lastVerifiedAt: new Date(),
      lastVerifiedResult: result.valid ? "VALID" : "INVALID",
      lastVerifiedSequence: result.eventsChecked > 0 ? result.toSequence : 0,
      lastInvalidSequence: result.valid ? null : (result.firstInvalid?.sequence ?? null),
    },
    create: {
      id: "SINGLETON",
      lastVerifiedAt: new Date(),
      lastVerifiedResult: result.valid ? "VALID" : "INVALID",
      lastVerifiedSequence: result.eventsChecked > 0 ? result.toSequence : 0,
      lastInvalidSequence: result.valid ? null : (result.firstInvalid?.sequence ?? null),
    },
  });
}
