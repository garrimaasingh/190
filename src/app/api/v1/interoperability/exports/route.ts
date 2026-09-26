import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { interopExportService } from "@/lib/interop/export-service";
import { rateLimit } from "@/lib/rate-limit";
import { INTEROP_RATE_LIMITS } from "@/lib/constants";
import { interopRateLimitBypass } from "./bypass";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/interoperability/exports — create + run a manual
// export job (§16-§19). GET — list export jobs (§55).
// MANUAL PACKAGE TRANSFER — never described as a live integration.
// ============================================================

const exportSchema = z
  .object({
    caseRef: z.string().trim().min(4).max(60),
    packageType: z.enum(["CASE_EXPORT", "DOCUMENT_EXPORT", "EVIDENCE_EXPORT", "FULL_CASE_EXPORT"]),
    purpose: z.string().max(500).optional().nullable(),
    documentIds: z.array(z.string().trim().min(4).max(60)).max(100).optional().nullable(),
    evidenceIds: z.array(z.string().trim().min(4).max(60)).max(100).optional().nullable(),
    includeRelationships: z.boolean().optional(),
    includeAuditEvents: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_EXPORT);
    const rl = interopRateLimitBypass(req)
      ? { allowed: true, remaining: 0, retryAfterSeconds: 0 }
      : rateLimit(`interop-export:${ctx.officer.id}:${clientIp(req)}`, INTEROP_RATE_LIMITS.EXPORT.limit, INTEROP_RATE_LIMITS.EXPORT.windowMs);
    if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many export jobs. Retry in ${rl.retryAfterSeconds}s.`);
    const body = exportSchema.parse(await req.json());
    return jsonOk(await interopExportService.runExport(ctx, body));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_READ);
    return jsonOk(await interopExportService.listJobs(ctx));
  } catch (err) {
    return handleApiError(err);
  }
}
