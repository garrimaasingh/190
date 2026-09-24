import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/ai/jobs/{jobId} (spec §49)
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { jobId } = await params;
    const job = await db.aIProcessingJob.findUnique({
      where: { jobId },
      include: { requestedByOfficer: { select: { officerId: true, name: true } } },
    });
    if (!job) throw new ApiError(404, "AI_JOB_NOT_FOUND", "AI job not found.");

    // Scope check: caller must be able to view the job's case.
    const scope = await buildAuthorizedScope(ctx);
    if (!scope.has(job.caseRef)) {
      throw new ApiError(404, "AI_JOB_NOT_FOUND", "AI job not found."); // 404, not 403 — no existence leak
    }

    return jsonOk({
      job: {
        jobId: job.jobId,
        documentRef: job.documentRef,
        caseRef: job.caseRef,
        jobType: job.jobType,
        status: job.status,
        priority: job.priority,
        stage: job.stage,
        model: { provider: job.modelProvider, modelName: job.modelName, modelVersion: job.modelVersion },
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        resultSummary: job.resultSummary ? JSON.parse(job.resultSummary) : null,
        requestedBy: job.requestedByOfficer,
        requestedByDepartmentId: job.requestedByDepartmentId,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
