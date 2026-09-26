import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationImportService } from "@/lib/integrations/services/import-service";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/simulate-change — MOCK-ONLY
// developer/demo control that simulates the EXTERNAL system mutating a
// case (spec §61 step 19: "Modify external mock case"). Refuses for
// non-MOCK connections and is audited. It NEVER touches central data —
// the change exists only on the simulated external side until a sync
// detects it and raises a conflict.
const simulateSchema = z
  .object({
    externalCaseId: z.string().trim().min(2).max(120),
    patch: z
      .object({
        title: z.string().trim().min(3).max(200).optional(),
        description: z.string().trim().max(2000).optional(),
        priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
        status: z.string().trim().max(60).optional(),
      })
      .strict(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_CONFIGURE);
    const { connectionId } = await params;
    const body = simulateSchema.parse(await req.json());
    return jsonOk(await integrationImportService.simulateExternalChange(ctx, connectionId, body.externalCaseId, body.patch));
  } catch (err) {
    return handleApiError(err);
  }
}
