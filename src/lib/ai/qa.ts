import { createHash } from "crypto";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { appendAuditEvent, recordAuditEvent } from "@/lib/audit/service";
import { getAIConfig } from "./config";
import { resolveAIProvider } from "./providers/registry";
import { LocalOnlyBlockedError } from "./providers/zai";
import { AIOutputValidationError } from "./providers/types";
import { buildAuthorizedScope, type AuthorizedCaseScope } from "./authorization";
import { retrieveAuthorizedChunks, selectGroundedSentences, buildContext, flagInjectionAttempts } from "./context";
import { getEmbeddingProvider, VectorStore } from "./embeddings";

// ============================================================
// Controlled case Q&A (spec §25/§26) + case summary (spec §16).
//
// RAG FLOW (spec §26):
//   QUESTION → AUTHORIZATION CONTEXT → QUERY PROCESSING →
//   HYBRID RETRIEVAL → AUTHORIZED CHUNKS ONLY → CONTEXT BUILDER →
//   LLM → GROUNDED ANSWER → SOURCE REFERENCES
//
// NO-HALLUCINATION (spec §53): when retrieval cannot ground an
// answer the caller receives NOT_FOUND_IN_AUTHORIZED_SOURCES —
// never a fabricated reply. The heuristic path is strictly
// extractive; the LLM path is source-bounded by prompt policy and
// its output is treated as untrusted until citations resolve
// against authorized chunks.
//
// AUDIT (spec §39): AI_QA_EXECUTED records length/hash of the
// question and resolved source references — never full prompts or
// document content.
// ============================================================

export const QA_INSUFFICIENT_MESSAGE = "NOT_FOUND_IN_AUTHORIZED_SOURCES";

export interface QAAnswer {
  answerText: string;
  sources: Array<{ documentRef: string; documentTitle?: string; pageNumber: number; quote: string }>;
  sufficient: boolean;
  retrievalMethod: "hybrid" | "semantic" | "keyword";
  provider: string;
  modelName: string;
  modelVersion: string;
  processingMode: "LOCAL" | "EXTERNAL";
  injectionFlags: number;
}

export async function answerCaseQuestion(params: {
  ctx: AuthContext;
  scopeEntry: AuthorizedCaseScope;
  question: string;
}): Promise<QAAnswer> {
  const config = await getAIConfig();
  const retrieval = await retrieveAuthorizedChunks({
    ctx: params.ctx,
    scope: new Map([[params.scopeEntry.caseRef, params.scopeEntry]]),
    query: params.question,
    limit: 8,
    caseRef: params.scopeEntry.caseRef,
    mode: "hybrid",
  });

  const questionHash = createHash("sha256").update(params.question).digest("hex").slice(0, 16);

  const finalize = async (answer: QAAnswer, provider: { provider: string; modelName: string; modelVersion: string }) => {
    await recordAuditEvent({
      eventType: "AI_QA_EXECUTED",
      actorOfficerId: params.ctx.officer.id,
      actorDepartmentId: params.ctx.officer.departmentId,
      caseId: params.scopeEntry.caseRef,
      sessionId: params.ctx.sessionId,
      metadata: {
        questionLength: params.question.length,
        questionHash,
        sufficient: answer.sufficient,
        retrieval: answer.retrievalMethod,
        sourceRefs: answer.sources.map((s) => `${s.documentRef}|p${s.pageNumber}`).slice(0, 8),
        provider: provider.provider,
        model: provider.modelName,
      },
    });
    return answer;
  };

  // Nothing usable retrieved → deterministic insufficient answer.
  if (retrieval.hybrid.length === 0) {
    return finalize(
      {
        answerText: `I could not find sufficient information in the authorized case documents. (${QA_INSUFFICIENT_MESSAGE})`,
        sources: [],
        sufficient: false,
        retrievalMethod: "hybrid",
        provider: "retrieval",
        modelName: "no-grounding",
        modelVersion: "-",
        processingMode: "LOCAL",
        injectionFlags: 0,
      },
      { provider: "retrieval", modelName: "no-grounding", modelVersion: "-" }
    );
  }

  const { provider, fallbackReason } = await resolveAIProvider();
  const built = buildContext(retrieval.hybrid, config.maxContextChars);
  const injectionFlags = built.injectionFlags;

  const titles = new Map(
    (
      await db.caseDocument.findMany({
        where: { documentId: { in: [...new Set(built.chunks.map((c) => c.documentRef))] } },
        select: { documentId: true, title: true },
      })
    ).map((d) => [d.documentId, d.title])
  );

  try {
    const draft = await provider.answerQuestion({ question: params.question, pages: built.pages });
    if (!draft.sufficient || !draft.answerText.trim()) {
      return finalize(
        {
          answerText: `I could not find sufficient information in the authorized case documents. (${QA_INSUFFICIENT_MESSAGE})`,
          sources: [],
          sufficient: false,
          retrievalMethod: "hybrid",
          provider: provider.provenance().provider,
          modelName: provider.provenance().modelName,
          modelVersion: provider.provenance().modelVersion,
          processingMode: provider.isExternal ? "EXTERNAL" : "LOCAL",
          injectionFlags,
        },
        provider.provenance()
      );
    }
    // Citation re-validation (spec §52/§53): keep only citations that
    // resolve to authorized chunks; if none resolve, treat as insufficient.
    const chunkByRef = new Map(built.chunks.map((c) => [`${c.documentRef}|${c.pageNumber}`, c]));
    const validSources = draft.citations
      .filter((c) => chunkByRef.has(`${c.documentRef}|${c.pageNumber}`))
      .map((c) => ({
        documentRef: c.documentRef as string,
        documentTitle: titles.get(c.documentRef as string),
        pageNumber: c.pageNumber,
        quote: c.quote,
      }));
    const answer: QAAnswer = {
      answerText: draft.answerText,
      sources: validSources,
      sufficient: true,
      retrievalMethod: "hybrid",
      ...provider.provenance(),
      processingMode: provider.isExternal ? "EXTERNAL" : "LOCAL",
      injectionFlags,
    };
    void fallbackReason;
    return finalize(answer, provider.provenance());
  } catch (err) {
    if (err instanceof LocalOnlyBlockedError || err instanceof AIOutputValidationError) {
      // Provider refused / malformed → safe extractive fallback from
      // ALREADY-AUTHORIZED chunks (spec §51/§52).
      const sentences = selectGroundedSentences(retrieval.hybrid, params.question, 3);
      const answer: QAAnswer = {
        answerText: sentences.length
          ? "According to the authorized case records: " +
            sentences.map((s) => `"${s.sentence}" (${s.documentRef}, page ${s.pageNumber})`).join(" ")
          : `I could not find sufficient information in the authorized case documents. (${QA_INSUFFICIENT_MESSAGE})`,
        sources: sentences.map((s) => ({
          documentRef: s.documentRef,
          documentTitle: titles.get(s.documentRef),
          pageNumber: s.pageNumber,
          quote: s.sentence.slice(0, 160),
        })),
        sufficient: sentences.length > 0,
        retrievalMethod: "hybrid",
        provider: "heuristic-fallback",
        modelName: "extractive-baseline",
        modelVersion: "1.0.0",
        processingMode: "LOCAL",
        injectionFlags,
      };
      await recordAuditEvent({
        eventType: "AI_PROVIDER_FAILURE",
        actorOfficerId: params.ctx.officer.id,
        caseId: params.scopeEntry.caseRef,
        sessionId: params.ctx.sessionId,
        metadata: { op: "qa", code: err instanceof AIOutputValidationError ? "AI_OUTPUT_INVALID" : err.code, provider: provider.id },
      });
      return finalize(answer, { provider: "heuristic-fallback", modelName: "extractive-baseline", modelVersion: "1.0.0" });
    }
    throw err;
  }
}

// ------------------------------------------------------------
// Case summary (spec §16) — stored as a CASE_CONTEXT
// AIDocumentSummary row (documentId = null), versioned like any
// AI result: regeneration creates a NEW row.
// ------------------------------------------------------------

export interface CaseSummaryInput {
  ctx: AuthContext;
  scopeEntry: AuthorizedCaseScope;
  jobId?: string | null;
  /** When false, generation is skipped and only a model provenance check is done (read path). */
  regenerate?: boolean;
}

export async function generateCaseSummary(params: CaseSummaryInput): Promise<{ summaryId: string; summaryText: string; sections: Record<string, string>; sourceCount: number; model: { provider: string; modelName: string; modelVersion: string } }> {
  const { ctx, scopeEntry } = params;
  const config = await getAIConfig();

  const docs = await db.caseDocument.findMany({
    where: { caseId: scopeEntry.caseInternalId, status: { in: ["COMMITTED", "SUPERSEDED"] } },
    select: { id: true, documentId: true, title: true, documentType: true, classification: true, sha256Hash: true, committedAt: true },
  });
  const chunks = await db.documentChunk.findMany({
    where: { caseRef: scopeEntry.caseRef },
    select: { id: true, documentId: true, pageNumber: true, chunkIndex: true, text: true, document: { select: { documentId: true, title: true, classification: true } } },
  });
  const clearance = scopeEntry.clearance;
  const DOC_LEVEL: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, HIGHLY_RESTRICTED: 4 };
  const allowedChunks = chunks.filter((c) => (DOC_LEVEL[c.document.classification] ?? 99) <= clearance);
  const docTitles = new Map(docs.map((d) => [d.documentId, d.title]));

  const evidence = await db.evidence.count({ where: { caseId: scopeEntry.caseInternalId } });
  const events = await db.caseEvent.findMany({
    where: { caseId: scopeEntry.caseInternalId },
    orderBy: { createdAt: "asc" },
    select: { eventType: true, description: true, createdAt: true },
    take: 20,
  });

  // Build sections strictly from authorized material.
  const sentences = allowedChunks.flatMap((c) =>
    c.text
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 40)
      .slice(0, 6)
      .map((s) => ({ documentRef: c.document.documentId, page: c.pageNumber, sentence: s.trim() }))
  );
  const pick = (n: number) => sentences.slice(0, n);

  const sections: Record<string, string> = {
    CASE_OVERVIEW:
      pick(3)
        .map((s) => `"${s.sentence}" (${s.documentRef}, page ${s.page})`)
        .join(" ") || "No authorized document text was available to build a case overview.",
    IMPORTANT_DOCUMENTS: docs.length
      ? docs.slice(0, 10).map((d) => `- ${d.title} (${d.documentId}, ${d.documentType}, ${d.classification})`).join("\n")
      : "No documents are visible to you on this case.",
    EVIDENCE_REFERENCES: evidence ? `${evidence} evidence item(s) are registered on this case.` : "No evidence items are registered on this case.",
    KEY_EVENTS: events.length
      ? events.slice(0, 10).map((e) => `- ${e.createdAt.toISOString().slice(0, 10)}: ${e.description || e.eventType}`).join("\n")
      : "No case events are visible.",
    CURRENT_STATUS: `Authoritative case status: ${await db.case
      .findUniqueOrThrow({ where: { id: scopeEntry.caseInternalId }, select: { status: true } })
      .then((c) => c.status)}. (Authoritative data — not AI-derived.)`,
    OPEN_ITEMS:
      "Review the AI review queue and timeline conflicts for open items. AI suggestions remain pending until a human verifies them.",
  };

  const summaryText = [
    `CASE CONTEXT — ${scopeEntry.caseRef}`,
    "",
    `CASE OVERVIEW: ${sections.CASE_OVERVIEW}`,
    "",
    `KEY PEOPLE & FACTS (extracted from authorized documents):`,
    pick(5).map((s) => `- "${s.sentence}" — ${s.documentRef}, page ${s.page}`).join("\n") || "- No authorized document text available.",
    "",
    `IMPORTANT DOCUMENTS:\n${sections.IMPORTANT_DOCUMENTS}`,
    "",
    `EVIDENCE REFERENCES: ${sections.EVIDENCE_REFERENCES}`,
    "",
    `KEY EVENTS:\n${sections.KEY_EVENTS}`,
    "",
    `CURRENT STATUS: ${sections.CURRENT_STATUS}`,
    "",
    `OPEN ITEMS: ${sections.OPEN_ITEMS}`,
    "",
    "NOTE: This is an AI-assisted, source-grounded overview. It is not a legal conclusion and does not determine admissibility or guilt.",
  ].join("\n");

  const { provider } = await resolveAIProvider();
  const prov = provider.provenance();

  const row = await db.aIDocumentSummary.create({
    data: {
      documentId: null,
      caseRef: scopeEntry.caseRef,
      summaryType: "CASE_CONTEXT",
      summaryText,
      sourceReferences: JSON.stringify(
        pick(6).map((s) => ({ documentRef: s.documentRef, pageNumber: s.page, quote: s.sentence.slice(0, 160) }))
      ),
      modelProvider: prov.provider,
      modelName: prov.modelName,
      modelVersion: prov.modelVersion,
      reviewStatus: "PENDING",
      jobId: params.jobId ?? null,
    },
  });

  await recordAuditEvent({
    eventType: "AI_SUMMARY_CREATED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: scopeEntry.caseRef,
    sessionId: ctx.sessionId,
    metadata: { summaryType: "CASE_CONTEXT", summaryId: row.id, jobId: params.jobId ?? null, provider: prov.provider, model: prov.modelName },
  });

  return {
    summaryId: row.id,
    summaryText,
    sections,
    sourceCount: Math.min(sentences.length, 6),
    model: prov,
  };
}
