import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildComplianceReport } from "@/lib/reports";

export const runtime = "nodejs";

// GET /api/v1/reports/compliance?caseId=... — compliance-SUPPORT
// report (spec §43): case history, custody history, document
// integrity summary, evidence custody, audit history summary.
// Explicitly NOT a claim of court admissibility or automatic legal
// compliance (the report body carries the disclaimer). Audit
// section requires AUDIT_READ.

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.REPORT_GENERATE);
    if (!ctx.permissions.includes(PERMISSIONS.AUDIT_READ)) {
      return jsonOk({ error: { code: "FORBIDDEN", message: "The compliance report includes audit history and requires audit visibility." } }, 403);
    }
    const url = new URL(req.url);
    const caseId = url.searchParams.get("caseId");
    if (!caseId) {
      return jsonOk({ error: "caseId query parameter is required." }, 422);
    }
    const report = await buildComplianceReport(ctx, caseId);
    return jsonOk({ report });
  } catch (err) {
    return handleApiError(err);
  }
}
