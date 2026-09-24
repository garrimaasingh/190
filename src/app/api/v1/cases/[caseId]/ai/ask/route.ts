import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireCaseAIAccess } from "@/lib/ai/authorization";
import { answerCaseQuestion } from "@/lib/ai/qa";
import { rateLimit } from "@/lib/rate-limit";
import { AI_RATE_LIMITS } from "@/lib/constants";
import { ApiError } from "@/lib/api";

export const runtime = "nodejs";

const askSchema = z.object({
  question: z.string().min(3).max(1000),
});

// POST /api/v1/cases/{caseId}/ai/ask (spec §25/§26/§47)
// CONTROLLED case Q&A. Flow: authorization context → hybrid
// retrieval over AUTHORIZED chunks only → bounded context →
// provider → grounded answer → source references. If grounding is
// insufficient the answer is NOT_FOUND_IN_AUTHORIZED_SOURCES —
// never fabricated.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const { ctx, caseRow, access } = await requireCaseAIAccess(req, (await params).caseId);
    const body = askSchema.parse(await req.json());
    const rl = rateLimit(`ai-ask:${ctx.officer.id}`, AI_RATE_LIMITS.ASK.limit, AI_RATE_LIMITS.ASK.windowMs);
    if (!rl.allowed) throw new ApiError(429, "AI_RATE_LIMITED", `Too many AI questions. Retry in ${rl.retryAfterSeconds}s.`);

    const answer = await answerCaseQuestion({
      ctx,
      scopeEntry: {
        caseRef: caseRow.caseId,
        caseInternalId: caseRow.id,
        clearance: (await import("@/lib/documents/authorization")).documentViewClearance(ctx, access),
        access,
      },
      question: body.question,
    });

    return jsonOk({
      answer: answer.answerText,
      sources: answer.sources,
      sufficient: answer.sufficient,
      retrievalMethod: answer.retrievalMethod,
      model: { provider: answer.provider, modelName: answer.modelName, modelVersion: answer.modelVersion },
      processingMode: answer.processingMode,
      injectionFlags: answer.injectionFlags,
      disclaimer:
        answer.sufficient
          ? "AI-generated answer grounded in the cited authorized sources. AI outputs may contain errors; verify against the sources. AI does not determine legal outcomes."
          : undefined,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
