import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationImportService } from "@/lib/integrations/services/import-service";
import { assertConnectionAccess } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// POST /api/v1/integrations/jobs/[jobId]/records/[recordId]/approve —
// explicit human approval of a STAGED import record (§15). Sensitive
// fields never auto-apply; this is the gate.
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string; recordId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_IMPORT);
    const { jobId, recordId } = await params;
    return jsonOk(await integrationImportService.approveStagedRecord(ctx, jobId, recordId));
  } catch (err) {
    if (err instanceof Error && err.message === "CONFLICT_NOT_FOUND") {
      return handleApiError(new ApiError(404, "NOT_FOUND", "Import job not found."));
    }
    return handleApiError(err);
  }
}

void assertConnectionAccess;
