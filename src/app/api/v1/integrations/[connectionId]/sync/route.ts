import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationSyncService } from "@/lib/integrations/services/sync-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEGRATION_RATE_LIMITS } from "@/lib/constants";
import { integrationRateLimitBypass } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/sync — run one incremental
// sync cycle now (cursor-based; §33/§34). Schedule creation happens
// lazily on first sync.
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_TEST);
    const { connectionId } = await params;
    const rl = integrationRateLimitBypass(req) ? { allowed: true, remaining: 0, retryAfterSeconds: 0 } : rateLimit(`integration-sync:${ctx.officer.id}`, INTEGRATION_RATE_LIMITS.SYNC.limit, INTEGRATION_RATE_LIMITS.SYNC.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many sync runs. Retry in ${rl.retryAfterSeconds}s.`);
    await integrationSyncService.ensureSchedule(ctx, connectionId).catch(() => undefined);
    return jsonOk(await integrationSyncService.runSync(ctx, connectionId));
  } catch (err) {
    return handleApiError(err);
  }
}
