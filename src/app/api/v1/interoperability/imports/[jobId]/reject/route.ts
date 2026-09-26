import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/imports/[jobId]/reject — reviewer
// rejection of the staged import (§39 decision REJECTED).
const rejectSchema = z.object({ comment: z.string().max(500).optional().nullable() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_REVIEW);
    const { jobId } = await params;
    const body = rejectSchema.parse(await req.json().catch(() => ({})));
    return jsonOk(await interopImportService.reject(ctx, jobId, body.comment ?? null));
  } catch (err) {
    return handleApiError(err);
  }
}
