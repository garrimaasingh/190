import { z } from "zod";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess, buildAuthorizedScope } from "@/lib/ai/authorization";
import { retrieveAuthorizedChunks, explainMatchTypes } from "@/lib/ai/context";
import { recordAuditEvent } from "@/lib/audit/service";
import { rateLimit } from "@/lib/rate-limit";
import { AI_RATE_LIMITS } from "@/lib/constants";
import { ApiError } from "@/lib/api";
import { createHash } from "crypto";

export const runtime = "nodejs";

const searchSchema = z.object({
  query: z.string().min(2).max(500),
  mode: z.enum(["semantic", "hybrid", "keyword"]).default("semantic"),
  caseRef: z.string().max(64).optional(), // optional narrowing to one authorized case
  limit: z.number().int().min(1).max(25).default(10),
});

async function runSearch(req: Request, mode: "semantic" | "hybrid" | "keyword") {
  const { ctx } = await requireAIAccess(req);
  const rl = rateLimit(`ai-search:${ctx.officer.id}`, AI_RATE_LIMITS.SEARCH.limit, AI_RATE_LIMITS.SEARCH.windowMs);
  if (!rl.allowed) {
    throw new ApiError(429, "AI_RATE_LIMITED", `Too many AI searches. Retry in ${rl.retryAfterSeconds}s.`);
  }
  const body = searchSchema.parse(await req.json());
  const effectiveMode = mode === "hybrid" ? body.mode : mode; // /search/semantic forces semantic, /search/hybrid honors mode

  const scope = await buildAuthorizedScope(ctx);
  if (body.caseRef && !scope.has(body.caseRef)) {
    // Requested case is outside the caller's authorization: return
    // empty results — never leak existence or content (spec §22/§59).
    await recordAuditEvent({
      eventType: "AI_SEARCH_EXECUTED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      result: "SUCCESS",
      metadata: { mode: effectiveMode, queryLength: body.query.length, results: 0, caseFilter: true, authorized: false },
    });
    return jsonOk({ results: [], mode: effectiveMode, authorizedCaseCount: scope.size });
  }

  const retrieval = await retrieveAuthorizedChunks({
    ctx,
    scope,
    query: body.query,
    limit: body.limit,
    caseRef: body.caseRef,
    mode: effectiveMode,
  });

  let results: Array<{ documentRef: string; documentTitle: string; caseRef: string; caseTitle: string; pageNumber: number; relevantText: string; relevance: number; matchType: string; classification: string }>;

  if (effectiveMode === "hybrid") {
    const explained = explainMatchTypes(retrieval);
    results = explained.map(({ chunk, matchType }) => ({
      documentRef: chunk.documentRef,
      documentTitle: chunk.documentTitle,
      caseRef: chunk.caseRef,
      caseTitle: chunk.caseTitle,
      pageNumber: chunk.pageNumber,
      relevantText: chunk.text.slice(0, 400),
      relevance: chunk.similarity,
      matchType,
      classification: chunk.classification,
    }));
  } else {
    const leg = effectiveMode === "semantic" ? retrieval.semantic : retrieval.keyword;
    results = leg.map((chunk) => ({
      documentRef: chunk.documentRef,
      documentTitle: chunk.documentTitle,
      caseRef: chunk.caseRef,
      caseTitle: chunk.caseTitle,
      pageNumber: chunk.pageNumber,
      relevantText: chunk.text.slice(0, 400),
      relevance: chunk.similarity,
      matchType: effectiveMode,
      classification: chunk.classification,
    }));
  }

  await recordAuditEvent({
    eventType: "AI_SEARCH_EXECUTED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    sessionId: ctx.sessionId,
    metadata: {
      mode: effectiveMode,
      queryLength: body.query.length,
      queryHash: createHash("sha256").update(body.query).digest("hex").slice(0, 16),
      results: results.length,
      authorizedCases: scope.size,
    },
  });

  return jsonOk({ results, mode: effectiveMode, authorizedCaseCount: scope.size });
}

// POST /api/v1/search/semantic (spec §23)
export async function POST(req: Request) {
  try {
    return await runSearch(req, "semantic");
  } catch (err) {
    return handleApiError(err);
  }
}
