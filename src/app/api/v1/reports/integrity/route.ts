import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildIntegrityReport } from "@/lib/reports";

export const runtime = "nodejs";

// GET /api/v1/reports/integrity?caseId=... — document + evidence
// integrity report (spec §42): IDs, SHA-256, algorithm, committed
// timestamps, stored status. NO file contents, NO confidential
// material beyond what the generator is cleared to see.

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.REPORT_GENERATE);
    const url = new URL(req.url);
    const caseId = url.searchParams.get("caseId");
    if (!caseId) {
      return jsonOk({ error: "caseId query parameter is required." }, 422);
    }
    const report = await buildIntegrityReport(ctx, caseId);
    return jsonOk({ report });
  } catch (err) {
    return handleApiError(err);
  }
}
