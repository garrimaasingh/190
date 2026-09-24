import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildChainOfCustodyReport } from "@/lib/reports";

export const runtime = "nodejs";

// GET /api/v1/reports/chain-of-custody?caseId=...&evidenceId=...
// Chain-of-custody report (spec §41/§65): collection details +
// chronological custody + integrity fingerprint + current custodian.
// JSON MVP; PDF export in a production format is a later deliverable
// (spec §41 permits this when report infrastructure exists).

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.REPORT_GENERATE);
    const url = new URL(req.url);
    const caseId = url.searchParams.get("caseId");
    const evidenceId = url.searchParams.get("evidenceId");
    if (!caseId || !evidenceId) {
      return jsonOk({ error: "caseId and evidenceId query parameters are required." }, 422);
    }
    const report = await buildChainOfCustodyReport(ctx, caseId, evidenceId);
    return jsonOk({ report });
  } catch (err) {
    return handleApiError(err);
  }
}
