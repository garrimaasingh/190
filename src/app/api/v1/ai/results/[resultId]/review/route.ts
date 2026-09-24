import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { reviewAIResult, type ReviewableType } from "@/lib/ai/review";
import { AI_REVIEWABLE_RESULT_TYPES } from "@/lib/constants";

export const runtime = "nodejs";

const reviewSchema = z.object({
  resultType: z.enum(AI_REVIEWABLE_RESULT_TYPES),
  action: z.enum(["VERIFIED", "REJECTED", "OVERRIDDEN"]),
  comment: z.string().max(1000).optional(),
  overrideType: z.string().max(60).optional(),
});

// POST /api/v1/ai/results/{resultId}/review (spec §49/§30/§45).
// Reviewer identity comes EXCLUSIVELY from the authenticated
// session — the request body cannot name a reviewer (spec §30).
// Every action writes an AIReview row + an immutable audit event.
export async function POST(req: Request, { params }: { params: Promise<{ resultId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { resultId } = await params;
    const body = reviewSchema.parse(await req.json());
    const result = await reviewAIResult(ctx, {
      resultType: body.resultType as ReviewableType,
      resultId,
      action: body.action,
      comment: body.comment,
      overrideType: body.overrideType,
    });
    return jsonOk({ reviewed: true, ...result });
  } catch (err) {
    return handleApiError(err);
  }
}
