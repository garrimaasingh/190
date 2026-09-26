import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { interopImportService } from "@/lib/interop/import-service";
import { CONFLICT_RESOLUTIONS } from "@/lib/interop/conflict-policy";

export const runtime = "nodejs";

// POST /api/v1/interoperability/conflicts/[conflictId]/resolve —
// resolve a conflict (§37): Accept Incoming | Keep Central | Merge |
// Reject. Policy constraints enforced server-side (§38 immutable
// fields, §41/§73 classification downgrade protection).
const resolveSchema = z
  .object({
    resolution: z.enum(CONFLICT_RESOLUTIONS),
    note: z.string().max(500).optional().nullable(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ conflictId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_REVIEW);
    const { conflictId } = await params;
    const body = resolveSchema.parse(await req.json());
    return jsonOk(await interopImportService.resolveConflict(ctx, conflictId, body.resolution, body.note ?? null));
  } catch (err) {
    return handleApiError(err);
  }
}
