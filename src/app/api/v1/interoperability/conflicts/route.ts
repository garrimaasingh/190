import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// GET /api/v1/interoperability/conflicts?jobId=… — conflict list (§36/§55).
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const jobId = new URL(req.url).searchParams.get("jobId") ?? undefined;
    return jsonOk(await interopImportService.listConflicts(ctx, jobId));
  } catch (err) {
    return handleApiError(err);
  }
}
