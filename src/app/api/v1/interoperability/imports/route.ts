import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEROP_LIMITS, INTEROP_RATE_LIMITS } from "@/lib/constants";
import { interopRateLimitBypass } from "../exports/bypass";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/interoperability/imports — upload a manual
// interoperability package (§23/§24/§25). The archive is staged
// ENCRYPTED and never unpacked into the application root.
// GET — list import jobs (§55).
// ============================================================

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_IMPORT);
    const rl = interopRateLimitBypass(req)
      ? { allowed: true, remaining: 0, retryAfterSeconds: 0 }
      : rateLimit(`interop-import:${ctx.officer.id}:${clientIp(req)}`, INTEROP_RATE_LIMITS.IMPORT.limit, INTEROP_RATE_LIMITS.IMPORT.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many import uploads. Retry in ${rl.retryAfterSeconds}s.`);

    const form = await req.formData().catch(() => null);
    if (!form) throw new ApiError(422, "VALIDATION_ERROR", "Expected multipart/form-data with a 'package' file.");
    const file = form.get("package");
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION_ERROR", "Missing 'package' file field.");
    if (file.size > INTEROP_LIMITS.MAX_UPLOAD_BYTES) {
      throw new ApiError(413, "ARCHIVE_TOO_LARGE", `Package exceeds the maximum upload size (${INTEROP_LIMITS.MAX_UPLOAD_BYTES} bytes).`);
    }
    const purpose = typeof form.get("purpose") === "string" ? String(form.get("purpose")) : null;
    const buffer = Buffer.from(await file.arrayBuffer());
    return jsonOk(await interopImportService.upload(ctx, buffer, { purpose }));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_READ);
    return jsonOk(await interopImportService.listJobs(ctx));
  } catch (err) {
    return handleApiError(err);
  }
}
