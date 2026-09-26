import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopExportService } from "@/lib/interop/export-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEROP_RATE_LIMITS } from "@/lib/constants";
import { interopRateLimitBypass } from "../../bypass";
import { handleApiError, ApiError } from "@/lib/api";

export const runtime = "nodejs";

// POST /api/v1/interoperability/exports/[jobId]/download — controlled
// package download (§21/§52/§75): authentication + ownership/scope +
// status + expiration checks, audited, streamed as attachment, no
// raw object-storage URLs are ever exposed.
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const { jobId } = await params;
    const rl = interopRateLimitBypass(req)
      ? { allowed: true, remaining: 0, retryAfterSeconds: 0 }
      : rateLimit(`interop-download:${ctx.officer.id}`, INTEROP_RATE_LIMITS.DOWNLOAD.limit, INTEROP_RATE_LIMITS.DOWNLOAD.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many downloads. Retry in ${rl.retryAfterSeconds}s.`);

    const result = await interopExportService.download(ctx, jobId);
    return new Response(new Uint8Array(result.zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(result.zip.length),
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-Package-Sha256": result.sha256,
        "X-Interop-Notice": "MANUAL PACKAGE TRANSFER - not a live system integration",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
