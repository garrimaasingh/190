import { z } from "zod";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { assertDocumentAIAccess } from "@/lib/ai/authorization";
import { enqueueAIJob, documentAIStatus } from "@/lib/ai/jobs";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { AI_JOB_TYPES, PAGE_SIZES } from "@/lib/constants";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const createSchema = z.object({
  jobType: z.enum(AI_JOB_TYPES),
  caseRef: z.string().min(4).max(64),
  documentRef: z.string().min(4).max(64).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
});

// POST /api/v1/ai/jobs (spec §49) — create an AI processing job.
// Authorization: AI use permission + case view + document clearance.
export async function POST(req: Request, ctxParams: { params: Promise<Record<string, string>> }) {
  try {
    void ctxParams;
    const { ctx } = await requireAIAccess(req);
    const body = createSchema.parse(await req.json());

    if (body.documentRef) {
      const { caseRow, doc, access } = await assertDocumentViewable(ctx, body.caseRef, body.documentRef, "view");
      await assertDocumentAIAccess(ctx, { id: caseRow.id, caseId: caseRow.caseId }, doc, access);
      const job = await enqueueAIJob({
        ctx,
        jobType: body.jobType,
        documentId: doc.id,
        documentRef: doc.documentId,
        caseInternalId: caseRow.id,
        caseRef: caseRow.caseId,
        priority: body.priority,
      });
      return jsonOk({ job: { jobId: job.jobId, jobType: job.jobType, status: job.status, createdAt: job.createdAt } }, 202);
    }

    // case-level job (e.g. TIMELINE_EXTRACTION across the case)
    const scope = await buildAuthorizedScope(ctx);
    const scopeEntry = scope.get(body.caseRef);
    if (!scopeEntry) throw new ApiError(403, "AI_ACCESS_DENIED", "You are not authorized to run AI jobs on this case.");
    const caseRow = await db.case.findUniqueOrThrow({ where: { id: scopeEntry.caseInternalId }, select: { caseId: true } });
    const job = await enqueueAIJob({
      ctx,
      jobType: body.jobType,
      caseInternalId: scopeEntry.caseInternalId,
      caseRef: caseRow.caseId,
      priority: body.priority,
    });
    return jsonOk({ job: { jobId: job.jobId, jobType: job.jobType, status: job.status, createdAt: job.createdAt } }, 202);
  } catch (err) {
    return handleApiError(err);
  }
}

const listSchema = z.object({
  status: z.string().optional(),
  jobType: z.string().optional(),
  caseRef: z.string().optional(),
  documentRef: z.string().optional(),
  requestedByMe: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZES.MAX).default(PAGE_SIZES.DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/v1/ai/jobs (spec §49) — job list with filters.
// AUDITOR/SYSTEM_ADMIN see globally; other roles see jobs of cases
// within their authorized scope only (query-level authorization).
export async function GET(req: Request) {
  try {
    const { ctx } = await requireAIAccess(req);
    const url = new URL(req.url);
    const q = listSchema.parse(Object.fromEntries(url.searchParams));

    const scope = await buildAuthorizedScope(ctx);
    const authorizedRefs = new Set(scope.keys());
    // SECURITY (spec §22): an empty authorized scope must return an
    // EMPTY list — never an unfiltered query. (Found by the Phase 5
    // authorization test suite.)
    if (authorizedRefs.size === 0) {
      return jsonOk({ jobs: [], total: 0 });
    }
    let caseRefs = q.caseRef ? [...authorizedRefs].filter((c) => c === q.caseRef) : [...authorizedRefs];
    if (q.caseRef && caseRefs.length === 0) {
      // Case exists but is outside the caller's scope — return empty, never leak.
      return jsonOk({ jobs: [], total: 0 });
    }

    const where = {
      ...(caseRefs.length ? { caseRef: { in: caseRefs } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.jobType ? { jobType: q.jobType } : {}),
      ...(q.documentRef ? { documentRef: q.documentRef } : {}),
      ...(q.requestedByMe ? { requestedByOfficerId: ctx.officer.id } : {}),
    };
    const [rows, total] = await Promise.all([
      db.aIProcessingJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        select: {
          id: true,
          jobId: true,
          documentRef: true,
          caseRef: true,
          jobType: true,
          status: true,
          priority: true,
          stage: true,
          modelProvider: true,
          modelName: true,
          modelVersion: true,
          errorCode: true,
          errorMessage: true,
          resultSummary: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          requestedByOfficer: { select: { officerId: true, name: true } },
        },
      }),
      db.aIProcessingJob.count({ where }),
    ]);

    return jsonOk({
      jobs: rows.map((j) => ({
        ...j,
        resultSummary: j.resultSummary ? JSON.parse(j.resultSummary) : null,
      })),
      total,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// Exported for the status route reuse
export { documentAIStatus };
