import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseManage } from "@/lib/cases/access";
import { recordAuditEvent } from "@/lib/audit/service";
import { syncCaseGraph } from "@/lib/graph/graph-sync";

export const runtime = "nodejs";

// POST /api/v1/graph/cases/{caseId}/sync — rebuild the case knowledge
// graph from central data (Phase 6, spec §67/§68). Role permission
// (graph.sync) is necessary but NOT sufficient: case-level MANAGE is
// enforced (custodian-side actors / system admin only). AUDITOR has
// neither permission and can never trigger a rebuild.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  let ctx;
  try {
    ctx = await requirePermission(req, PERMISSIONS.GRAPH_SYNC);
    const { caseId } = await params;

    // Case-level manage FIRST so denials carry the case context.
    const { caseRow } = await assertCaseManage(ctx, caseId);

    try {
      const result = await syncCaseGraph(caseRow.caseId, { triggeredByOfficerId: ctx.officer.id });
      return jsonOk(result);
    } catch (syncErr) {
      // A failed rebuild must leave an audit trace (best-effort insert,
      // awaited — but the failure response is the security-relevant part).
      await recordAuditEvent({
        eventType: "GRAPH_SYNC_FAILED",
        actorOfficerId: ctx.officer.id,
        caseId: caseRow.caseId,
        result: "FAILED",
        metadata: {
          reason: syncErr instanceof Error ? syncErr.message.slice(0, 200) : "UNKNOWN",
        },
      });
      throw syncErr;
    }
  } catch (err) {
    return handleApiError(err);
  }
}
