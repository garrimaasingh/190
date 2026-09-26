import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationExportService } from "@/lib/integrations/services/export-service";

export const runtime = "nodejs";

// GET /api/v1/integrations/jobs/[jobId]/manifest — integrity manifest
// of an export job (§45): document id, filename, SHA-256, size, mime,
// export timestamp, export job id. Authorized actors only.
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { jobId } = await params;
    return jsonOk(await integrationExportService.getManifest(ctx, jobId));
  } catch (err) {
    if (err instanceof Error && err.message.includes("No package archived")) {
      return handleApiError(new ApiError(404, "NOT_FOUND", "No package archived for this job."));
    }
    return handleApiError(err);
  }
}
