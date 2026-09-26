import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationImportService } from "@/lib/integrations/services/import-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEGRATION_RATE_LIMITS } from "@/lib/constants";
import { integrationRateLimitBypass } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/import — start an import job (§16/§24/§25/§27).
// The job outcome (COMPLETED/PARTIAL/FAILED with per-record staging)
// is returned as data — provider failures are never 5xx crashes (§59).
const importSchema = z
  .object({
    importType: z.enum(["CASE", "DOCUMENT", "EVIDENCE", "CASE_BUNDLE"]),
    externalCaseId: z.string().trim().min(2).max(120),
    externalDocumentId: z.string().trim().max(120).optional().nullable(),
    externalEvidenceId: z.string().trim().max(120).optional().nullable(),
    targetCaseRef: z.string().trim().max(60).optional().nullable(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_IMPORT);
    const { connectionId } = await params;
    const rl = integrationRateLimitBypass(req) ? { allowed: true, remaining: 0, retryAfterSeconds: 0 } : rateLimit(`integration-import:${ctx.officer.id}:${clientIp(req)}`, INTEGRATION_RATE_LIMITS.IMPORT.limit, INTEGRATION_RATE_LIMITS.IMPORT.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many import jobs. Retry in ${rl.retryAfterSeconds}s.`);
    const body = importSchema.parse(await req.json());
    return jsonOk(await integrationImportService.runImport(ctx, connectionId, body));
  } catch (err) {
    return handleApiError(err);
  }
}
