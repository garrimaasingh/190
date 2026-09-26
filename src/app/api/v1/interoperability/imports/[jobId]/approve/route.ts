import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/imports/[jobId]/approve — explicit
// reviewer approval (§39). Separation of duties enforced server-side:
// the uploader can never approve their own job when the policy is on.
const approveSchema = z.object({ comment: z.string().max(500).optional().nullable() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_REVIEW);
    const { jobId } = await params;
    const body = approveSchema.parse(await req.json().catch(() => ({})));
    return jsonOk(await interopImportService.approve(ctx, jobId, body.comment ?? null));
  } catch (err) {
    return handleApiError(err);
  }
}
