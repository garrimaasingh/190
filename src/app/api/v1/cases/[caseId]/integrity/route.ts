import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { verifyChain } from "@/lib/audit/integrity";
import { AUDIT_GENESIS_HASH } from "@/lib/audit/canonical";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/integrity — case integrity summary
// (spec §62): informational counts + live chain status for the case
// dashboard. Available to every case viewer; the chain check is the
// authoritative full-chain verification.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.PROFILE_READ);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const [documentCount, evidenceCount, custodyTransferCount, auditEventCount, chain, state] = await Promise.all([
      db.caseDocument.count({ where: { caseId: caseRow.id, status: { in: ["COMMITTED", "SUPERSEDED"] } } }),
      db.evidence.count({ where: { caseId: caseRow.id } }),
      db.caseTransfer.count({ where: { caseId: caseRow.id, status: { in: ["ACCEPTED", "REJECTED", "CANCELLED"] } } }),
      ctx.permissions.includes(PERMISSIONS.AUDIT_READ)
        ? db.auditEvent.count({ where: { caseId: caseRow.caseId } })
        : Promise.resolve(null), // audit-event count is auditor/admin information
      verifyChain(db),
      db.auditChainState.findUnique({ where: { id: "SINGLETON" } }),
    ]);

    return jsonOk({
      caseId: caseRow.caseId,
      documents: documentCount,
      evidence: evidenceCount,
      custodyTransfers: custodyTransferCount,
      auditEvents: auditEventCount,
      auditEventsNote: auditEventCount === null ? "Audit event totals are visible to auditors and administrators." : undefined,
      chain: {
        valid: chain.valid,
        algorithm: chain.algorithm,
        eventCount: state?.eventCount ?? 0,
        lastEventHash: state?.lastEventHash || AUDIT_GENESIS_HASH,
        lastVerifiedAt: state?.lastVerifiedAt ?? null,
        informationalOnly: true,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
