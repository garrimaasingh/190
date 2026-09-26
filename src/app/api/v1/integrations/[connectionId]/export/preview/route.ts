import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationExportService } from "@/lib/integrations/services/export-service";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/export/preview — export
// authorization preview (§43): shows which requested cases the actor
// may export before creating the job. Never leaks unauthorized case
// metadata — only the exclusion reason.
const previewSchema = z
  .object({ caseRefs: z.array(z.string().trim().min(6).max(60)).min(1).max(20) })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_EXPORT);
    const { connectionId } = await params;
    const body = previewSchema.parse(await req.json());
    return jsonOk(await integrationExportService.previewExport(ctx, connectionId, body.caseRefs));
  } catch (err) {
    return handleApiError(err);
  }
}
