import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopExportService } from "@/lib/interop/export-service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/exports/[jobId]/cancel — cancel a
// QUEUED/PROCESSING export job (§19 statuses).
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_EXPORT);
    const { jobId } = await params;
    return jsonOk(await interopExportService.cancel(ctx, jobId));
  } catch (err) {
    return handleApiError(err);
  }
}
