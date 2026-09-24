/**
 * SQLite immutability guards (Phase 4, spec §24/§58).
 *
 * Prisma db push recreates tables on schema change, so these
 * triggers must be (re-)applied AFTER every db push. Idempotent:
 * CREATE TRIGGER IF NOT EXISTS.
 *
 * What the guards enforce at the DATABASE level (defense in depth
 * beyond "no API exists"):
 *   - AuditEvent: no UPDATE, no DELETE (append-only ledger, §24/§58)
 *   - AuditChainState: no DELETE (the chain head must persist)
 *   - LedgerAnchor: no UPDATE/DELETE (commitments are historical)
 *   - Evidence: no DELETE; integrity fields frozen once committed
 *   - EvidenceTransfer: no DELETE; decided rows (status != REQUESTED)
 *     can never be edited — only the REQUESTED→decided lifecycle
 *     transition is a legal UPDATE (§58 "UPDATE transfer history FAIL")
 *   - EvidenceDocumentRelationship: no UPDATE/DELETE (history)
 *
 * PostgreSQL equivalent for production: REVOKE UPDATE/DELETE FROM
 * application role + rules/triggers (documented in the report).
 */
import { PrismaClient } from "@prisma/client";

const GUARDS = [
  // ---- Audit ledger ----
  // Append-only, with ONE narrow lifecycle exception: ledgerStatus may
  // flip UNANCHORED → ANCHORED (the anchoring commitment, spec §31).
  // Every content field — both hashes, sequence, ids, actor, result,
  // metadata, timestamps — is frozen: any other UPDATE aborts.
  `DROP TRIGGER IF EXISTS audit_events_no_update`,
  `CREATE TRIGGER audit_events_no_update
     BEFORE UPDATE ON AuditEvent
     WHEN NEW.eventHash != OLD.eventHash
       OR NEW.previousEventHash != OLD.previousEventHash
       OR NEW.sequence != OLD.sequence
       OR NEW.eventId != OLD.eventId
       OR NEW.eventType != OLD.eventType
       OR NEW.actorOfficerId IS NOT OLD.actorOfficerId
       OR NEW.actorDepartmentId IS NOT OLD.actorDepartmentId
       OR NEW.actorIdentifier IS NOT OLD.actorIdentifier
       OR NEW.caseId IS NOT OLD.caseId
       OR NEW.documentId IS NOT OLD.documentId
       OR NEW.evidenceId IS NOT OLD.evidenceId
       OR NEW.sessionId IS NOT OLD.sessionId
       OR NEW.timestamp != OLD.timestamp
       OR NEW.result != OLD.result
       OR NEW.ipAddress IS NOT OLD.ipAddress
       OR NEW.deviceId IS NOT OLD.deviceId
       OR NEW.userAgent IS NOT OLD.userAgent
       OR NEW.metadata IS NOT OLD.metadata
       OR NEW.createdAt != OLD.createdAt
       OR (OLD.ledgerStatus = 'ANCHORED' AND NEW.ledgerStatus != 'ANCHORED')
       OR (OLD.ledgerStatus = 'UNANCHORED' AND NEW.ledgerStatus NOT IN ('UNANCHORED', 'ANCHORED'))
   BEGIN
     SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: audit event content is frozen; only ledgerStatus may progress UNANCHORED -> ANCHORED');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
     BEFORE DELETE ON AuditEvent
   BEGIN
     SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: audit events can never be deleted');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS audit_chain_state_no_delete
     BEFORE DELETE ON AuditChainState
   BEGIN
     SELECT RAISE(ABORT, 'AUDIT_CHAIN_STATE_PERSISTED');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS ledger_anchors_no_update
     BEFORE UPDATE ON LedgerAnchor
   BEGIN
     SELECT RAISE(ABORT, 'LEDGER_ANCHOR_IMMUTABLE');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS ledger_anchors_no_delete
     BEFORE DELETE ON LedgerAnchor
   BEGIN
     SELECT RAISE(ABORT, 'LEDGER_ANCHOR_IMMUTABLE');
   END;`,
  // ---- Evidence ----
  `CREATE TRIGGER IF NOT EXISTS evidence_no_delete
     BEFORE DELETE ON Evidence
   BEGIN
     SELECT RAISE(ABORT, 'EVIDENCE_IMMUTABLE: evidence records are never deleted');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS evidence_integrity_frozen
     BEFORE UPDATE ON Evidence
     WHEN OLD.sha256Hash IS NOT NULL AND (
       NEW.sha256Hash IS NULL OR NEW.sha256Hash != OLD.sha256Hash
       OR NEW.hashAlgorithm != OLD.hashAlgorithm
       OR NEW.storageKey != OLD.storageKey
       OR NEW.storageProvider != OLD.storageProvider
       OR NEW.hasDigitalContent != OLD.hasDigitalContent
     )
   BEGIN
     SELECT RAISE(ABORT, 'EVIDENCE_IMMUTABLE: integrity/storage fields are frozen after commit');
   END;`,
  // ---- Custody history ----
  `CREATE TRIGGER IF NOT EXISTS evidence_transfers_no_delete
     BEFORE DELETE ON EvidenceTransfer
   BEGIN
     SELECT RAISE(ABORT, 'CUSTODY_HISTORY_IMMUTABLE: transfer records are never deleted');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS evidence_transfers_decided_immutable
     BEFORE UPDATE ON EvidenceTransfer
     WHEN OLD.status != 'REQUESTED'
   BEGIN
     SELECT RAISE(ABORT, 'CUSTODY_HISTORY_IMMUTABLE: decided transfers can never be edited');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS evidence_relationships_no_update
     BEFORE UPDATE ON EvidenceDocumentRelationship
   BEGIN
     SELECT RAISE(ABORT, 'EVIDENCE_RELATIONSHIP_IMMUTABLE');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS evidence_relationships_no_delete
     BEFORE DELETE ON EvidenceDocumentRelationship
   BEGIN
     SELECT RAISE(ABORT, 'EVIDENCE_RELATIONSHIP_IMMUTABLE');
   END;`,
];

async function main() {
  const db = new PrismaClient();
  try {
    let applied = 0;
    for (const sql of GUARDS) {
      await db.$executeRawUnsafe(sql);
      applied++;
    }
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%immutable%' OR (type='trigger' AND name LIKE 'audit_%') OR (type='trigger' AND name LIKE 'evidence_%') OR (type='trigger' AND name LIKE 'ledger_%')`
    );
    console.log(`[sqlite-guards] ${applied} guards ensured (${n} phase-4 triggers present).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[sqlite-guards] FAILED:", err);
  process.exit(1);
});
