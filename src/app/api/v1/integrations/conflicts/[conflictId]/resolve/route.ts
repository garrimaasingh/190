import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationConflictService } from "@/lib/integrations/services/conflict-service";

export const runtime = "nodejs";

// POST /api/v1/integrations/conflicts/[conflictId]/resolve — human
// conflict resolution (§22). RESOLVED_EXTERNAL / MERGED apply the
// external (or merged) value; RESOLVED_CENTRAL / IGNORED keep the
// central record. Every resolution is audited.
const resolveSchema = z
  .object({
    resolution: z.enum(["RESOLVED_CENTRAL", "RESOLVED_EXTERNAL", "MERGED", "IGNORED"]),
    note: z.string().trim().max(500).optional().nullable(),
    mergedValue: z.string().trim().max(300).optional().nullable(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ conflictId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_RESOLVE_CONFLICT);
    const { conflictId } = await params;
    const body = resolveSchema.parse(await req.json());
    try {
      const result = await integrationConflictService.resolveConflict(ctx, conflictId, body.resolution, body.note ?? null, body.mergedValue ?? null);
      return jsonOk({ conflictId, resolution: body.resolution, applied: result.applied, conflict: { status: result.conflict.status, resolvedAt: result.conflict.resolvedAt } });
    } catch (err) {
      if (err instanceof Error && err.message === "CONFLICT_NOT_FOUND") throw new ApiError(404, "NOT_FOUND", "Conflict not found.");
      if (err instanceof Error && err.message === "CONFLICT_ALREADY_RESOLVED") throw new ApiError(409, "CONFLICT", "Conflict has already been resolved.");
      throw err;
    }
  } catch (err) {
    return handleApiError(err);
  }
}
