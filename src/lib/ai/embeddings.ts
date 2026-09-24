import { db } from "@/lib/db";
import { getAIConfig } from "./config";
import { AI_EMBEDDING_DIMENSION, DOCUMENT_CLASSIFICATION_LEVEL } from "@/lib/constants";
import type { ModelProvenance } from "./providers/types";

// ============================================================
// EmbeddingService + VectorStore (spec §20/§21).
//
// Provider: LocalHashingEmbeddingProvider — a deterministic,
// dependency-free lexical embedding (hashed token unigrams +
// bigrams into a fixed 256-dim signed bag-of-features vector,
// L2-normalized). It is a DEVELOPMENT BASELINE, honestly labeled:
// it powers real semantic-ish retrieval (shares vocabulary and
// stems-ish overlap) but is NOT a neural embedding model, and the
// model registry entry says exactly that.
//
// The EmbeddingProvider interface is the seam for a real model
// (OpenAI-compatible / HuggingFace adapters) — none is claimed as
// implemented.
//
// VECTOR STORE: the project runs SQLite, so pgvector (spec §21
// "prefer PostgreSQL + pgvector IF compatible") is NOT used;
// vectors are stored as JSON on DocumentEmbedding and compared
// with exact cosine similarity over the AUTHORIZED scope in the
// query itself (spec §22). Raw embeddings are never returned by
// any API (spec §23/§24).
// ============================================================

export interface EmbeddingProvider {
  readonly id: string;
  provenance(): ModelProvenance & { dimension: number };
  generate_embedding(text: string): Promise<Float32Array>;
  generate_batch_embeddings(texts: string[]): Promise<Float32Array[]>;
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z\u0900-\u097F0-9]+/g)
      ?.filter((t) => t.length >= 2) || []
  );
}

export const LocalHashingEmbeddingProvider: EmbeddingProvider = {
  id: "local-hashing",
  provenance() {
    return { provider: "local-hashing", modelName: "hashed-bow-256d", modelVersion: "1.0.0", dimension: AI_EMBEDDING_DIMENSION };
  },

  async generate_embedding(text: string): Promise<Float32Array> {
    const vectors = await this.generate_batch_embeddings([text]);
    return vectors[0];
  },

  async generate_batch_embeddings(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = new Float32Array(AI_EMBEDDING_DIMENSION);
      const tokens = tokenize(text);
      const features: string[] = [...tokens];
      // bigrams for light word-order sensitivity
      for (let i = 0; i + 1 < tokens.length; i++) features.push(`${tokens[i]}_${tokens[i + 1]}`);
      for (const f of features) {
        const h = fnv1a(f);
        const bucket = h % AI_EMBEDDING_DIMENSION;
        const sign = (h >>> 31) & 1 ? -1 : 1;
        vec[bucket] += sign * (f.includes("_") ? 0.7 : 1); // bigrams slightly damped
      }
      // L2 normalize
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    });
  },
};

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function getEmbeddingProvider(providerId?: string): Promise<EmbeddingProvider> {
  const config = await getAIConfig();
  const wanted = providerId || config.embeddingProvider;
  // single active provider; the interface is the production seam
  return LocalHashingEmbeddingProvider;
}

// ------------------------------------------------------------
// VectorStore (spec §21)
// ------------------------------------------------------------
export interface VectorMatch {
  chunkId: string;
  documentRef: string;
  caseRef: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  documentTitle: string;
  classification: string;
  similarity: number;
}

export const VectorStore = {
  async upsert_embedding(params: {
    chunkId: string;
    documentId: string; // internal
    documentRef: string;
    caseRef: string;
    vector: Float32Array;
    prov: ModelProvenance & { dimension: number };
    jobId?: string;
  }): Promise<void> {
    const data = {
      chunkId: params.chunkId,
      documentId: params.documentId,
      caseRef: params.caseRef,
      provider: params.prov.provider,
      modelName: params.prov.modelName,
      modelVersion: params.prov.modelVersion,
      dimension: params.prov.dimension,
      vectorJson: JSON.stringify(Array.from(params.vector, (v) => Math.round(v * 1e5) / 1e5)),
      jobId: params.jobId ?? null,
    };
    await db.documentEmbedding.upsert({
      where: { chunkId: params.chunkId },
      create: data,
      update: data,
    });
  },

  /**
   * Similarity search. `scope` is the SERVER-DERIVED authorized
   * scope (spec §22): caseRef → maximum classification level the
   * caller may see on that case. Chunks outside the scope are
   * excluded in this function — before any result leaves the
   * backend. There is no "search everything, filter later" path.
   */
  async search_similar(params: {
    queryVector: Float32Array;
    scope: Map<string, number>; // caseRef → clearance level (DOCUMENT_CLASSIFICATION_LEVEL scale)
    limit?: number;
    threshold?: number;
    caseRef?: string; // optional single-case narrowing
    documentId?: string; // internal document narrowing
  }): Promise<VectorMatch[]> {
    const scopeEntries = [...params.scope.entries()];
    if (!scopeEntries.length) return [];
    const rows = await db.documentEmbedding.findMany({
      where: {
        caseRef: params.caseRef ? { in: scopeEntries.map(([c]) => c).filter((c) => !params.caseRef || c === params.caseRef) } : { in: scopeEntries.map(([c]) => c) },
        ...(params.documentId ? { documentId: params.documentId } : {}),
      },
      select: {
        id: true,
        chunkId: true,
        caseRef: true,
        vectorJson: true,
        chunk: {
          select: {
            text: true,
            pageNumber: true,
            chunkIndex: true,
            document: { select: { documentId: true, title: true, classification: true } },
          },
        },
      },
    });
    const limit = params.limit || 10;
    const threshold = params.threshold ?? 0.08;
    const matches: VectorMatch[] = [];
    for (const row of rows) {
      const clearance = params.scope.get(row.caseRef);
      if (clearance === undefined) continue; // scope re-check (defense in depth)
      const level = DOCUMENT_LEVEL[row.chunk.document.classification] ?? 99;
      if (level > clearance) continue; // classification enforcement INSIDE the search
      let vec: number[];
      try {
        vec = JSON.parse(row.vectorJson);
      } catch {
        continue;
      }
      const similarity = cosineSimilarity(params.queryVector, vec);
      if (similarity < threshold) continue;
      matches.push({
        chunkId: row.chunkId,
        documentRef: row.chunk.document.documentId,
        caseRef: row.caseRef,
        pageNumber: row.chunk.pageNumber,
        chunkIndex: row.chunk.chunkIndex,
        text: row.chunk.text,
        documentTitle: row.chunk.document.title,
        classification: row.chunk.document.classification,
        similarity: Math.round(similarity * 10000) / 10000,
      });
    }
    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  },

  async search_by_case(caseRef: string, limit = 20): Promise<Array<{ chunkId: string }>> {
    const rows = await db.documentEmbedding.findMany({
      where: { caseRef },
      select: { chunkId: true },
      take: limit,
    });
    return rows;
  },

  async search_by_document(documentId: string, limit = 20): Promise<Array<{ chunkId: string }>> {
    const rows = await db.documentEmbedding.findMany({
      where: { documentId },
      select: { chunkId: true },
      take: limit,
    });
    return rows;
  },

  async delete_embedding(chunkId: string): Promise<void> {
    // Interface completeness (spec §21). Under platform immutability
    // policy derived rows of COMMITTED documents are not deleted in
    // normal flows; the method exists for reconciliation tooling.
    await db.documentEmbedding.deleteMany({ where: { chunkId } });
  },
};

const DOCUMENT_LEVEL: Record<string, number> = DOCUMENT_CLASSIFICATION_LEVEL;
