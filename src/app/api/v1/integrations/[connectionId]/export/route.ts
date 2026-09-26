import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationExportService } from "@/lib/integrations/services/export-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEGRATION_RATE_LIMITS } from "@/lib/constants";
import { integrationRateLimitBypass } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/export — explicit export job (§17/§43/§44).
// Case-level authorization is enforced per case; unauthorized cases
// are excluded (never included silently).
const exportSchema = z
  .object({
    exportType: z.enum(["CASE_PACKAGE", "DOCUMENT", "EVIDENCE"]).default("CASE_PACKAGE"),
    caseRefs: z.array(z.string().trim().min(6).max(60)).min(1).max(20),
    includeDocumentContent: z.boolean().optional().default(false),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_EXPORT);
    const { connectionId } = await params;
    const rl = integrationRateLimitBypass(req) ? { allowed: true, remaining: 0, retryAfterSeconds: 0 } : rateLimit(`integration-export:${ctx.officer.id}:${clientIp(req)}`, INTEGRATION_RATE_LIMITS.EXPORT.limit, INTEGRATION_RATE_LIMITS.EXPORT.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many export jobs. Retry in ${rl.retryAfterSeconds}s.`);
    const body = exportSchema.parse(await req.json());
    return jsonOk(await integrationExportService.runExport(ctx, connectionId, body));
  } catch (err) {
    return handleApiError(err);
  }
}
