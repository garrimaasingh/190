import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationConflictService } from "@/lib/integrations/services/conflict-service";

export const runtime = "nodejs";

// GET /api/v1/integrations/conflicts — conflict list (§22/§42).
// Shows central vs external values with sources and timestamps.
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const url = new URL(req.url);
    const result = await integrationConflictService.listConflicts({
      status: url.searchParams.get("status") || undefined,
      caseRef: url.searchParams.get("caseRef") || undefined,
      page: Number(url.searchParams.get("page") || 1),
      pageSize: Number(url.searchParams.get("pageSize") || 20),
    });
    return jsonOk(result);
  } catch (err) {
    return handleApiError(err);
  }
}
