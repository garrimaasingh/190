import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireCaseAIAccess } from "@/lib/ai/authorization";
import { appendAuditEvent } from "@/lib/audit/service";
import { db } from "@/lib/db";
import { AI_TIMELINE_EVENT_TYPES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/ai/timeline — AI timeline suggestions
// for the whole case + surfaced conflicts (spec §17/§18/§71).
// Separation from the official case timeline is explicit.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const { ctx } = await requireCaseAIAccess(req, (await params).caseId);
    const caseRef = (await params).caseId;
    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");

    const [events, conflicts] = await Promise.all([
      db.aITimelineEvent.findMany({
        where: {
          caseRef,
          ...(typeFilter && (AI_TIMELINE_EVENT_TYPES as readonly string[]).includes(typeFilter) ? { eventType: typeFilter } : {}),
          ...(statusFilter ? { reviewStatus: statusFilter } : {}),
        },
        orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }],
        include: { document: { select: { documentId: true, title: true } } },
      }),
      db.aITimelineConflict.findMany({
        where: { caseRef, ...(statusFilter === "UNREVIEWED" ? { status: "UNREVIEWED" } : {}) },
        include: {
          eventA: { select: { id: true, description: true, eventDate: true, eventDateText: true, eventType: true, documentRef: true, sourceReference: true } },
          eventB: { select: { id: true, description: true, eventDate: true, eventDateText: true, eventType: true, documentRef: true, sourceReference: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return jsonOk({
      note: "AI-SUGGESTED events are separate from the official case timeline and never become case events automatically.",
      timelineEvents: events.map((e) => ({
        id: e.id,
        eventDate: e.eventDate,
        eventDateText: e.eventDateText,
        eventTime: e.eventTime,
        eventType: e.eventType,
        description: e.description,
        document: e.document ? { documentRef: e.document.documentId, title: e.document.title } : null,
        sourceReference: e.sourceReference,
        confidence: e.confidence,
        reviewStatus: e.reviewStatus,
        model: { provider: e.modelProvider, modelName: e.modelName, modelVersion: e.modelVersion },
        createdAt: e.createdAt,
      })),
      conflicts: conflicts.map((c) => ({
        id: c.id,
        conflictType: c.conflictType,
        description: c.description,
        status: c.status,
        resolutionNote: c.resolutionNote,
        resolvedAt: c.resolvedAt,
        sourceA: { eventRef: c.eventA.documentRef, page: c.eventA.sourceReference, date: c.eventA.eventDate ?? c.eventA.eventDateText, description: c.eventA.description, eventType: c.eventA.eventType },
        sourceB: { eventRef: c.eventB.documentRef, page: c.eventB.sourceReference, date: c.eventB.eventDate ?? c.eventB.eventDateText, description: c.eventB.description, eventType: c.eventB.eventType },
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const generateSchema = z.object({}).optional();

// POST /api/v1/cases/{caseId}/ai/timeline (spec §49) — run timeline
// extraction across ALL authorized documents of the case. Creates
// job-less synchronous suggestions for documents that already hold
// normalized text; documents without text are reported as skipped.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const { ctx, caseRow, access, config } = await requireCaseAIAccess(req, (await params).caseId);
    await generateSchema.parse(await req.json().catch(() => ({})));

    const { documentViewClearance } = await import("@/lib/documents/authorization");
    const clearance = documentViewClearance(ctx, access);
    const docs = await db.caseDocument.findMany({
      where: { caseId: caseRow.id, status: { in: ["COMMITTED", "SUPERSEDED"] } },
      select: { id: true, documentId: true, classification: true, title: true },
    });
    const DOC_LEVEL: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, HIGHLY_RESTRICTED: 4 };
    const authorized = docs.filter((d) => (DOC_LEVEL[d.classification] ?? 99) <= clearance);

    const { enqueueAIJob } = await import("@/lib/ai/jobs");
    const job = await enqueueAIJob({
      ctx,
      jobType: "TIMELINE_EXTRACTION",
      caseInternalId: caseRow.id,
      caseRef: caseRow.caseId,
    });
    void config;
    return jsonOk(
      {
        jobId: job.jobId,
        authorizedDocuments: authorized.map((d) => d.documentId),
        message: "Case timeline extraction queued. Suggestions will appear under AI timeline events; they never modify the official timeline.",
      },
      202
    );
  } catch (err) {
    return handleApiError(err);
  }
}
