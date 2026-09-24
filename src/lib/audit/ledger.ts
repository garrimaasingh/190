import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES, LEDGER_ACTIVE_ADAPTER } from "@/lib/constants";
import { verifyRange, type ChainVerificationResult } from "@/lib/audit/integrity";
import { recordAuditEvent } from "@/lib/audit/service";
import type { AuthContext } from "@/lib/auth";

// ============================================================
// ImmutableLedgerService + LedgerAdapter abstraction (spec §30/§31/
// §67/§68).
//
// The application depends ONLY on the LedgerAdapter interface —
// never on a concrete ledger SDK. Phase 4 ships the DATABASE
// adapter (MVP: anchors persist in the same database, self-verifying
// against the hash chain). A HyperledgerFabricAdapter is provided
// as an explicitly-labeled STUB: it is never registered active and
// every operation fails with NOT_IMPLEMENTED. Phase 4 does NOT
// claim blockchain functionality (spec §31/§68/§74).
//
// Only INTEGRITY REFERENCES are ever anchored (chain head hash +
// sequence) — never document/evidence binaries (spec §68).
// ============================================================

export interface LedgerAnchorRequest {
  chainHash: string;
  upToSequence: number;
  eventCount: number;
  anchoredByOfficerId?: string | null;
}

export interface LedgerAnchorResult {
  provider: string;
  externalReference: string;
}

/**
 * LedgerAdapter — implement this to add a new immutable backend.
 * Phase 5+ candidates: HyperledgerFabricAdapter (real network),
 * public-chain notarization, HSM-signed checkpoints.
 */
export interface LedgerAdapter {
  readonly name: string;
  readonly live: boolean;
  anchor(request: LedgerAnchorRequest): Promise<LedgerAnchorResult>;
  verify(anchorRef: string, expected: { chainHash: string; upToSequence: number }): Promise<{ valid: boolean; detail?: string }>;
}

// ------------------------------------------------------------
// MVP adapter: DATABASE (live) — anchored hash + range are stored
// in LedgerAnchor; verify() recomputes the chain head for the
// stored range and compares.
// ------------------------------------------------------------
export class DatabaseLedgerAdapter implements LedgerAdapter {
  readonly name = "DATABASE";
  readonly live = true;

  async anchor(request: LedgerAnchorRequest): Promise<LedgerAnchorResult> {
    // The anchor id itself is derived content — reproducible reference.
    const externalReference = `db-anchor:${request.upToSequence}:${request.chainHash.slice(0, 16)}`;
    return { provider: this.name, externalReference };
  }

  async verify(anchorRef: string, expected: { chainHash: string; upToSequence: number }) {
    const anchor = await db.ledgerAnchor.findUnique({ where: { anchorId: anchorRef } });
    if (!anchor) return { valid: false, detail: "Anchor not found." };
    if (anchor.chainHash !== expected.chainHash || anchor.upToSequence !== expected.upToSequence) {
      return { valid: false, detail: "Anchor does not cover the requested range." };
    }
    const result: ChainVerificationResult = await verifyRange(db, 1, anchor.upToSequence);
    if (!result.valid) return { valid: false, detail: `Chain invalid at sequence ${result.firstInvalid?.sequence}.` };
    if (result.headHash !== anchor.chainHash) {
      return { valid: false, detail: "Chain head does not match the anchored hash." };
    }
    return { valid: true };
  }
}

// ------------------------------------------------------------
// STUB adapter: Hyperledger Fabric (spec §30/§67) — interface seam
// only. NOT live, NOT claimed anywhere as implemented. Wiring this
// in requires a real Fabric network + gateway SDK (Phase 5+).
// ------------------------------------------------------------
export class HyperledgerFabricAdapter implements LedgerAdapter {
  readonly name = "HYPERLEDGER_FABRIC";
  readonly live = false;

  private static readonly NOT_IMPLEMENTED =
    "Hyperledger Fabric anchoring is NOT implemented in this phase — interface stub only (spec §30/§31).";

  async anchor(_request: LedgerAnchorRequest): Promise<LedgerAnchorResult> {
    throw new ApiError(501, ERROR_CODES.LEDGER_ERROR, HyperledgerFabricAdapter.NOT_IMPLEMENTED);
  }

  async verify(_anchorRef: string, _expected: { chainHash: string; upToSequence: number }): Promise<{ valid: boolean; detail?: string }> {
    throw new ApiError(501, ERROR_CODES.LEDGER_ERROR, HyperledgerFabricAdapter.NOT_IMPLEMENTED);
  }
}

const ADAPTERS: Record<string, LedgerAdapter> = {
  DATABASE: new DatabaseLedgerAdapter(),
  HYPERLEDGER_FABRIC: new HyperledgerFabricAdapter(),
};

export function getLedgerAdapter(name: string = LEDGER_ACTIVE_ADAPTER): LedgerAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new ApiError(422, ERROR_CODES.LEDGER_ERROR, `Unknown ledger adapter: ${name}`);
  return adapter;
}

export function listLedgerAdapters() {
  return Object.values(ADAPTERS).map((a) => ({ name: a.name, live: a.live }));
}

// ------------------------------------------------------------
// ImmutableLedgerService — anchor the CURRENT chain head.
// ------------------------------------------------------------
export async function anchorChain(ctx: AuthContext): Promise<{
  anchorId: string;
  provider: string;
  chainHash: string;
  upToSequence: number;
  eventCount: number;
  externalReference: string | null;
}> {
  const adapter = getLedgerAdapter(); // always the live adapter
  const state = await db.auditChainState.findUnique({ where: { id: "SINGLETON" } });
  if (!state || state.lastSequence === 0) {
    throw new ApiError(409, ERROR_CODES.LEDGER_ERROR, "The audit chain is empty — nothing to anchor yet.");
  }

  // Verify before anchoring: never anchor an invalid chain head.
  const verification = await verifyRange(db, 1, state.lastSequence);
  if (!verification.valid) {
    await recordAuditEvent({
      eventType: "LEDGER_VERIFY_FAILED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      result: "FAILED",
      metadata: { reason: "chain invalid before anchor", sequence: verification.firstInvalid?.sequence },
    });
    throw new ApiError(409, ERROR_CODES.AUDIT_CHAIN_INVALID, "The audit chain failed verification — anchoring refused.");
  }

  const anchorResult = await adapter.anchor({
    chainHash: state.lastEventHash,
    upToSequence: state.lastSequence,
    eventCount: state.eventCount,
    anchoredByOfficerId: ctx.officer.id,
  });

  const { generateAnchorId } = await import("@/lib/cases/ids");
  const anchorId = await generateAnchorId(new Date().getUTCFullYear());

  const anchor = await db.ledgerAnchor.create({
    data: {
      anchorId,
      provider: adapter.name,
      chainHash: state.lastEventHash,
      upToSequence: state.lastSequence,
      eventCount: state.eventCount,
      anchoredByOfficerId: ctx.officer.id,
      externalReference: anchorResult.externalReference,
    },
  });

  // Mark the anchored range on the events themselves (spec §23 ledger_status).
  await db.auditEvent.updateMany({
    where: { sequence: { lte: state.lastSequence }, ledgerStatus: "UNANCHORED" },
    data: { ledgerStatus: "ANCHORED" },
  });

  await recordAuditEvent({
    eventType: "LEDGER_ANCHORED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    metadata: { anchorId, upToSequence: state.lastSequence, chainHash: state.lastEventHash, provider: adapter.name },
  });

  return {
    anchorId: anchor.anchorId,
    provider: anchor.provider,
    chainHash: anchor.chainHash,
    upToSequence: anchor.upToSequence,
    eventCount: anchor.eventCount,
    externalReference: anchor.externalReference,
  };
}

export async function verifyAnchor(ctx: AuthContext, anchorRef: string) {
  const anchor = await db.ledgerAnchor.findUnique({ where: { anchorId: anchorRef } });
  if (!anchor) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "Anchor not found.");
  const adapter = getLedgerAdapter(anchor.provider);
  const result = await adapter.verify(anchorRef, { chainHash: anchor.chainHash, upToSequence: anchor.upToSequence });
  await recordAuditEvent({
    eventType: result.valid ? "LEDGER_ANCHOR_VERIFIED" : "LEDGER_VERIFY_FAILED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    result: result.valid ? "SUCCESS" : "FAILED",
    metadata: { anchorId: anchor.anchorId, provider: anchor.provider },
  });
  return {
    anchorId: anchor.anchorId,
    provider: anchor.provider,
    valid: result.valid,
    detail: result.detail ?? null,
    chainHash: anchor.chainHash,
    upToSequence: anchor.upToSequence,
    anchoredAt: anchor.anchoredAt,
  };
}
