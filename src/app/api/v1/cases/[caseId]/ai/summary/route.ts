import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireCaseAIAccess } from "@/lib/ai/authorization";
import { generateCaseSummary } from "@/lib/ai/qa";
import { recordAuditEvent } from "@/lib/audit/service";
import { rateLimit } from "@/lib/rate-limit";
import { AI_RATE_LIMITS } from "@/lib/constants";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/ai/summary — latest case summary (read).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const { ctx } = await requireCaseAIAccess(req, (await params).caseId);
    const caseRef = (await params).caseId;
    const rows = await db.aIDocumentSummary.findMany({
      where: { caseRef, summaryType: "CASE_CONTEXT", documentId: null },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    return jsonOk({
      summaries: rows.map((s, i) => ({
        id: s.id,
        summaryText: s.summaryText,
        sourceReferences: s.sourceReferences ? JSON.parse(s.sourceReferences) : [],
        latest: i === 0,
        reviewStatus: s.reviewStatus,
        model: { provider: s.modelProvider, modelName: s.modelName, modelVersion: s.modelVersion },
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const generateSchema = z.object({}).optional();

// POST /api/v1/cases/{caseId}/ai/summary (spec §16) — generate a
// case-level summary from AUTHORIZED material only. Rate limited;
// audited; stored as a new versioned row (regeneration never
// overwrites the previous summary).
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const { ctx, caseRow, access } = await requireCaseAIAccess(req, (await params).caseId);
    await generateSchema.parse(await req.json().catch(() => ({})));
    const rl = rateLimit(`ai-summary:${ctx.officer.id}`, AI_RATE_LIMITS.SUMMARY.limit, AI_RATE_LIMITS.SUMMARY.windowMs);
    if (!rl.allowed) throw new ApiError(429, "AI_RATE_LIMITED", `Too many AI summary requests. Retry in ${rl.retryAfterSeconds}s.`);

    const result = await generateCaseSummary({
      ctx,
      scopeEntry: {
        caseRef: caseRow.caseId,
        caseInternalId: caseRow.id,
        clearance: (await import("@/lib/documents/authorization")).documentViewClearance(ctx, access),
        access,
      },
    });
    return jsonOk(
      {
        summaryId: result.summaryId,
        sections: result.sections,
        summaryText: result.summaryText,
        sourceCount: result.sourceCount,
        model: result.model,
        disclaimer:
          "AI-assisted, source-grounded overview. AI outputs may contain errors and are not authoritative unless human verified. AI does not determine legal outcomes or admissibility.",
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}
