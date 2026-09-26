import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// GET /api/v1/interoperability/imports/[jobId] — import job detail:
// package inspector (§58), staged records, conflicts, approvals,
// integrity/signature/scan status. Payload contents are NOT exposed
// before commit — staged metadata only (§58/§59/§60).
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const { jobId } = await params;
    return jsonOk(await interopImportService.getJob(ctx, jobId));
  } catch (err) {
    return handleApiError(err);
  }
}
