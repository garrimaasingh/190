import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { verifyChain, cacheVerificationState } from "@/lib/audit/integrity";
import { AUDIT_GENESIS_HASH } from "@/lib/audit/canonical";
import { recordAuditEvent } from "@/lib/audit/service";
import { listLedgerAdapters } from "@/lib/audit/ledger";

export const runtime = "nodejs";

// ============================================================
// GET  /api/v1/audit/integrity — chain status snapshot (spec §61):
// persisted chain state + last cached verification. Never hides a
// recorded integrity failure.
// POST /api/v1/audit/integrity — run a FULL chain verification from
// genesis (spec §28/§73 step 19). AUDITOR may verify (read-level);
// the result is cached to the chain state for the dashboard.
// ============================================================

export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.AUDIT_READ);

    const state = await db.auditChainState.findUnique({ where: { id: "SINGLETON" } });
    return jsonOk({
      chain: {
        eventCount: state?.eventCount ?? 0,
        lastSequence: state?.lastSequence ?? 0,
        lastEventHash: state?.lastEventHash || AUDIT_GENESIS_HASH,
        lastEventId: state?.lastEventId ?? null,
        genesisHash: AUDIT_GENESIS_HASH,
        hashAlgorithm: "SHA-256",
      },
      lastVerification: state?.lastVerifiedAt
        ? {
            verifiedAt: state.lastVerifiedAt,
            result: state.lastVerifiedResult,
            verifiedThroughSequence: state.lastVerifiedSequence,
            firstInvalidSequence: state.lastInvalidSequence,
          }
        : null,
      ledgerAdapters: listLedgerAdapters(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.AUDIT_VERIFY);
    const result = await verifyChain(db);
    await cacheVerificationState(result);

    await recordAuditEvent({
      eventType: "AUDIT_CHAIN_VERIFIED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: result.valid ? "SUCCESS" : "FAILED",
      metadata: {
        eventsChecked: result.eventsChecked,
        valid: result.valid,
        ...(result.firstInvalid
          ? { firstInvalidSequence: result.firstInvalid.sequence, reason: result.firstInvalid.reason }
          : {}),
      },
    });

    return jsonOk({
      valid: result.valid,
      algorithm: result.algorithm,
      eventsChecked: result.eventsChecked,
      fromSequence: result.fromSequence,
      toSequence: result.toSequence,
      headHash: result.headHash,
      firstInvalid: result.firstInvalid,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
