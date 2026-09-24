import { db } from "@/lib/db";
import { AI_SOURCE_DELIMITER_CLOSE, AI_SOURCE_DELIMITER_OPEN, AI_INJECTION_PATTERNS } from "@/lib/constants";
import { getEmbeddingProvider, VectorStore, cosineSimilarity, type VectorMatch } from "./embeddings";
import { splitSentences } from "./providers/heuristic";
import type { AuthorizedCaseScope } from "./authorization";
import type { AuthContext } from "@/lib/auth";
import type { SourcePage } from "./providers/types";

// ============================================================
// AIContextBuilder (spec §36) — the security boundary between
// application data and the AI layer.
//
// Responsibilities (spec §36):
//  - determine authorized documents (clearance-filtered)
//  - retrieve relevant chunks WITHIN the authorized scope
//  - enforce classification restrictions
//  - enforce context limits (maxContextChars)
//  - preserve source references
//  - wrap every piece of retrieved content in explicit
//    <authorized_source> delimiters — retrieved documents are
//    UNTRUSTED DATA and must never be executed as instructions
//    (spec §35 trust hierarchy)
// ============================================================

export interface RetrievedChunk extends VectorMatch {
  caseTitle: string;
}

export interface BuiltContext {
  pages: SourcePage[]; // delimiter-ready source blocks
  chunks: RetrievedChunk[];
  charactersUsed: number;
  truncated: boolean;
  injectionFlags: number; // count of injection-pattern matches found in retrieved content
}

/** Flag probable prompt-injection attempts inside document content (spec §35). */
export function flagInjectionAttempts(text: string): number {
  return AI_INJECTION_PATTERNS.reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);
}

/**
 * Hybrid retrieval (spec §24): keyword scoring + semantic scoring
 * combined. Authorization is applied by the VectorStore scope and
 * re-checked here against the caller's per-case clearance — a
 * double gate, both server-side.
 */
export async function retrieveAuthorizedChunks(params: {
  ctx: AuthContext;
  scope: Map<string, AuthorizedCaseScope>;
  query: string;
  limit?: number;
  caseRef?: string;
  mode?: "keyword" | "semantic" | "hybrid";
}): Promise<{ semantic: RetrievedChunk[]; keyword: RetrievedChunk[]; hybrid: RetrievedChunk[] }> {
  const limit = params.limit || 10;
  const mode = params.mode || "hybrid";

  // ---- semantic leg ----
  let semantic: RetrievedChunk[] = [];
  if (mode === "semantic" || mode === "hybrid") {
    const provider = await getEmbeddingProvider();
    const qv = await provider.generate_embedding(params.query);
    const raw = await VectorStore.search_similar({
      queryVector: qv,
      scope: new Map([...params.scope.entries()].map(([caseRef, s]) => [caseRef, s.clearance])),
      limit: limit * 2,
      caseRef: params.caseRef,
    });
    semantic = await decorate(raw);
  }

  // ---- keyword leg (server-side over authorized cases only) ----
  let keyword: RetrievedChunk[] = [];
  const terms = params.query.toLowerCase().match(/[a-z\u0900-\u097F0-9]+/g)?.filter((t) => t.length >= 3) || [];
  if ((mode === "keyword" || mode === "hybrid") && terms.length) {
    const caseRefs = params.caseRef
      ? [...params.scope.keys()].filter((c) => c === params.caseRef)
      : [...params.scope.keys()];
    if (caseRefs.length) {
      const rows = await db.documentChunk.findMany({
        where: { caseRef: { in: caseRefs } },
        select: {
          id: true,
          caseRef: true,
          pageNumber: true,
          chunkIndex: true,
          text: true,
          document: { select: { documentId: true, title: true, classification: true } },
        },
      });
      const lowerTerms = terms.map((t) => t.toLowerCase());
      keyword = await decorate(
        rows
          .filter((row) => {
            // classification enforcement happens here AND in VectorStore
            const clearance = params.scope.get(row.caseRef)?.clearance ?? -1;
            const level = DOC_LEVEL[row.document.classification] ?? 99;
            if (level > clearance) return false;
            const lower = row.text.toLowerCase();
            return lowerTerms.some((t) => lower.includes(t));
          })
          .map((row) => {
            const lower = row.text.toLowerCase();
            const score =
              lowerTerms.reduce((acc, t) => acc + (lower.split(t).length - 1), 0) /
              Math.max(Math.sqrt(row.text.length), 1);
            return {
              chunkId: row.id,
              documentRef: row.document.documentId,
              caseRef: row.caseRef,
              pageNumber: row.pageNumber,
              chunkIndex: row.chunkIndex,
              text: row.text,
              documentTitle: row.document.title,
              classification: row.document.classification,
              similarity: Math.min(1, Math.round(score * 100) / 100),
            };
          })
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit * 2)
      );
    }
  }

  // ---- hybrid fusion (max-normalized weighted sum) ----
  const hybridMap = new Map<string, { item: RetrievedChunk; kw: number; sem: number }>();
  const maxKw = Math.max(...keyword.map((k) => k.similarity), 0.000001);
  const maxSem = Math.max(...semantic.map((s) => s.similarity), 0.000001);
  for (const k of keyword) hybridMap.set(k.chunkId, { item: k, kw: k.similarity / maxKw, sem: 0 });
  for (const s of semantic) {
    const existing = hybridMap.get(s.chunkId);
    if (existing) existing.sem = s.similarity / maxSem;
    else hybridMap.set(s.chunkId, { item: s, kw: 0, sem: s.similarity / maxSem });
  }
  const hybrid = [...hybridMap.values()]
    .map((e) => ({ ...e.item, similarity: Math.round((0.45 * e.kw + 0.55 * e.sem) * 10000) / 10000 }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return {
    semantic: semantic.slice(0, limit),
    keyword: keyword.slice(0, limit),
    hybrid,
  };
}

async function decorate(raw: VectorMatch[]): Promise<RetrievedChunk[]> {
  if (!raw.length) return [];
  const cases = await db.case.findMany({
    where: { caseId: { in: raw.map((r) => r.caseRef) } },
    select: { caseId: true, title: true },
  });
  const titles = new Map(cases.map((c) => [c.caseId, c.title]));
  return raw.map((r) => ({ ...r, caseTitle: titles.get(r.caseRef) || "" }));
}

/** Label each leg of a hybrid result set (spec §24: explain the match type). */
export function explainMatchTypes(params: {
  semantic: RetrievedChunk[];
  keyword: RetrievedChunk[];
  hybrid: RetrievedChunk[];
}): Array<{ chunk: RetrievedChunk; matchType: "keyword" | "semantic" | "hybrid" }> {
  const kwIds = new Set(params.keyword.map((k) => k.chunkId));
  const semIds = new Set(params.semantic.map((s) => s.chunkId));
  return params.hybrid.map((chunk) => {
    const inKw = kwIds.has(chunk.chunkId);
    const inSem = semIds.has(chunk.chunkId);
    return { chunk, matchType: inKw && inSem ? "hybrid" : inKw ? "keyword" : "semantic" };
  });
}

/**
 * Assemble the final model context: chunk texts as delimited source
 * blocks, size-capped by maxContextChars (spec §36).
 */
export function buildContext(chunks: RetrievedChunk[], maxChars: number): BuiltContext {
  const pages: SourcePage[] = [];
  let used = 0;
  let truncated = false;
  let injectionFlags = 0;
  for (const chunk of chunks) {
    injectionFlags += flagInjectionAttempts(chunk.text);
    if (used + chunk.text.length > maxChars) {
      truncated = true;
      break;
    }
    pages.push({ pageNumber: chunk.pageNumber, text: chunk.text, documentRef: chunk.documentRef });
    used += chunk.text.length;
  }
  return { pages, chunks, charactersUsed: used, truncated, injectionFlags };
}

/** Wrap source blocks in explicit delimiters for prompt assembly (spec §35). */
export function renderDelimitedSources(pages: SourcePage[]): string {
  return pages
    .map(
      (p) =>
        `${AI_SOURCE_DELIMITER_OPEN}\ndocument=${p.documentRef || "unknown"} page=${p.pageNumber}\n${p.text}\n${AI_SOURCE_DELIMITER_CLOSE}`
    )
    .join("\n\n");
}

/** Sentence-level best matches for grounded Q&A (used by the heuristic path). */
export function selectGroundedSentences(chunks: RetrievedChunk[], question: string, max: number) {
  const QUESTION_STOPWORDS = new Set([
    "what", "who", "whom", "whose", "when", "where", "why", "how", "the", "and", "for", "was", "were", "has",
    "have", "had", "with", "from", "that", "this", "there", "their", "his", "her", "its", "are", "did", "does",
    "about", "into", "which", "you", "your", "can", "could", "would", "tell",
  ]);
  const qWords = new Set(
    (question.toLowerCase().match(/[a-z\u0900-\u097F0-9]+/g) || []).filter((w) => w.length >= 3 && !QUESTION_STOPWORDS.has(w))
  );
  const candidates: Array<{ documentRef: string; pageNumber: number; sentence: string; score: number }> = [];
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const words = sentence.toLowerCase().match(/[a-z\u0900-\u097F0-9]+/g) || [];
      if (words.length < 4) continue;
      let hits = 0;
      for (const w of words) if (qWords.has(w)) hits++;
      if (!hits) continue;
      candidates.push({
        documentRef: chunk.documentRef,
        pageNumber: chunk.pageNumber,
        sentence,
        score: hits / Math.sqrt(words.length),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, max);
}

const DOC_LEVEL: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, HIGHLY_RESTRICTED: 4 };
