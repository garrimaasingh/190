import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationConflictService } from "@/lib/integrations/services/conflict-service";

export const runtime = "nodejs";

// GET /api/v1/integrations/conflicts/[conflictId] — conflict detail (§42).
export async function GET(req: Request, { params }: { params: Promise<{ conflictId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { conflictId } = await params;
    const conflict = await integrationConflictService.getConflict(conflictId);
    if (!conflict) throw new ApiError(404, "NOT_FOUND", "Conflict not found.");
    return jsonOk(conflict);
  } catch (err) {
    return handleApiError(err);
  }
}
