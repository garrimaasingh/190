import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const runtime = "nodejs";

// GET /api/v1/interoperability/conflicts/[conflictId] — single conflict
// with incoming vs central values (§37 UI data).
export async function GET(req: Request, { params }: { params: Promise<{ conflictId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const { conflictId } = await params;
    const conflict = await db.manualImportConflict.findUnique({
      where: { conflictId },
      include: { importJob: { select: { jobId: true, status: true, uploadedByDepartmentId: true } } },
    });
    if (!conflict) throw new ApiError(404, "NOT_FOUND", "Conflict not found.");
    return jsonOk({ ...conflict, importJob: { jobId: conflict.importJob.jobId, status: conflict.importJob.status } });
  } catch (err) {
    return handleApiError(err);
  }
}
