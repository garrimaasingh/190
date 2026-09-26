import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/imports/[jobId]/commit — CENTRAL IMPORT
// (§23 "CENTRAL IMPORT" step): approved records are committed through
// the REAL Phase 3/4 pipelines, Phase 5 auto-enqueue runs, affected
// cases re-sync into the Phase 6 graph (§62/§63). Honest PARTIAL
// results (§45) — never a fake SUCCESS when records failed.
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_IMPORT);
    const { jobId } = await params;
    return jsonOk(await interopImportService.commit(ctx, jobId));
  } catch (err) {
    return handleApiError(err);
  }
}
