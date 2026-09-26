import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/imports/[jobId]/validate — run the
// full validation pipeline: archive security → schema gate →
// integrity verification → signature status → security scan →
// staging → reference resolution → conflict detection (§23 steps 4-10).
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_IMPORT);
    const { jobId } = await params;
    return jsonOk(await interopImportService.validate(ctx, jobId));
  } catch (err) {
    return handleApiError(err);
  }
}
