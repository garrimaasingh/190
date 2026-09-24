import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ERROR_CODES } from "@/lib/constants";
import { anchorChain, listLedgerAdapters } from "@/lib/audit/ledger";

export const runtime = "nodejs";

// ============================================================
// GET  /api/v1/ledger/anchors — list chain anchors (auditor-visible).
// POST /api/v1/ledger/anchors — anchor the CURRENT chain head
// (spec §30/§31). SYSTEM_ADMIN (LEDGER_MANAGE). Anchoring verifies
// the chain first and refuses to anchor an invalid head. MVP =
// DATABASE adapter; Hyperledger Fabric is a documented stub (spec
// §31: Phase 4 must not fail without external infrastructure).
// ============================================================

export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.AUDIT_READ);
    const anchors = await db.ledgerAnchor.findMany({
      orderBy: { anchoredAt: "desc" },
      take: 100,
    });
    return jsonOk({
      anchors: anchors.map((a) => ({
        anchorId: a.anchorId,
        provider: a.provider,
        chainHash: a.chainHash,
        upToSequence: a.upToSequence,
        eventCount: a.eventCount,
        externalReference: a.externalReference,
        anchoredAt: a.anchoredAt,
      })),
      adapters: listLedgerAdapters(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.AUDIT_READ);
    if (!ctx.permissions.includes(PERMISSIONS.LEDGER_MANAGE)) {
      throw new ApiError(403, ERROR_CODES.FORBIDDEN, "Only the platform administrator can anchor the audit chain.");
    }
    const result = await anchorChain(ctx);
    return jsonOk(result, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
