import { z } from "zod";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { appendAuditEvent } from "@/lib/audit/service";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const bodySchema = z.object({}).optional();

// POST /api/v1/ai/jobs/{jobId}/cancel — cancel a QUEUED job.
// Only the requester or SYSTEM_ADMIN may cancel; PROCESSING jobs
// are not interrupted mid-stage (the stage loop checks status).
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    await bodySchema.parse(await req.json().catch(() => ({})));
    const { jobId } = await params;
    const job = await db.aIProcessingJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "AI_JOB_NOT_FOUND", "AI job not found.");
    const scope = await buildAuthorizedScope(ctx);
    if (!scope.has(job.caseRef)) throw new ApiError(404, "AI_JOB_NOT_FOUND", "AI job not found.");
    if (ctx.officer.role !== "SYSTEM_ADMIN" && job.requestedByOfficerId !== ctx.officer.id) {
      throw new ApiError(403, "AI_ACCESS_DENIED", "Only the requesting officer or a platform administrator can cancel this job.");
    }
    const cancelled = await db.aIProcessingJob.updateMany({
      where: { id: job.id, status: "QUEUED" }, // conditional — atomic
      data: { status: "CANCELLED", completedAt: new Date(), stage: "Cancelled" },
    });
    if (cancelled.count === 0) {
      throw new ApiError(409, "AI_JOB_NOT_CANCELLABLE", `A job in status ${job.status} can no longer be cancelled.`);
    }
    await appendAuditEvent({
      eventType: "AI_JOB_CANCELLED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: job.caseRef,
      documentId: job.documentRef ?? null,
      sessionId: ctx.sessionId,
      metadata: { jobId },
    });
    return jsonOk({ jobId, status: "CANCELLED" });
  } catch (err) {
    return handleApiError(err);
  }
}
