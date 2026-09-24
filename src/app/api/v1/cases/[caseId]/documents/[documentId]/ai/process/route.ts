import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess, assertDocumentAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { enqueueAIJob, documentAIStatus } from "@/lib/ai/jobs";
import { AI_JOB_TYPES } from "@/lib/constants";

export const runtime = "nodejs";

const bodySchema = z.object({
  jobType: z.enum(AI_JOB_TYPES).default("FULL_ANALYSIS"),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
});

// POST /api/v1/cases/{caseId}/documents/{documentId}/ai/process
// (maps to spec §49 POST /api/v1/documents/{document_id}/ai/process
// on the platform's case-scoped route architecture).
// Enqueues an ASYNCHRONOUS AI job (spec §4/§5) — processing happens
// in the worker, never in this request. Rate limited per officer.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx, config } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { caseRow, doc, access } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    await assertDocumentAIAccess(ctx, { id: caseRow.id, caseId: caseRow.caseId }, doc, access);

    const body = bodySchema.parse(await req.json().catch(() => ({})));
    const job = await enqueueAIJob({
      ctx,
      jobType: body.jobType,
      documentId: doc.id,
      documentRef: doc.documentId,
      caseInternalId: caseRow.id,
      caseRef: caseRow.caseId,
      priority: body.priority,
      requestedProvider: config.llmProvider,
    });

    return jsonOk(
      {
        job: {
          jobId: job.jobId,
          jobType: job.jobType,
          status: job.status,
          priority: job.priority,
          requestedByOfficerId: ctx.officer.officerId,
          createdAt: job.createdAt,
        },
        message: "AI processing request queued. The worker processes jobs asynchronously; AI failure never affects the document.",
      },
      202
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/process —
// convenience alias of the AI status read path (spec §48 statuses).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    return jsonOk(await documentAIStatus(doc.id));
  } catch (err) {
    return handleApiError(err);
  }
}
