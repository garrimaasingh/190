import { AI_CHUNK_MAX_CHARS, AI_CHUNK_TARGET_CHARS } from "@/lib/constants";

// ============================================================
// Deterministic chunking (spec §19).
//
// Chunks split paragraph-boundary-first, then sentence, then hard
// cut — the SAME input text ALWAYS yields the same chunk sequence
// (no model in the loop). Every chunk keeps its page number so
// embeddings and search results retain document/page provenance.
// Content from different documents is NEVER mixed.
// ============================================================

export interface ChunkDraft {
  pageNumber: number;
  chunkIndex: number;
  text: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  // deterministic approximation: words + punctuation groups
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).length * 1.3));
}

export function chunkPages(pages: Array<{ pageNumber: number; text: string }>): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  for (const page of pages) {
    const text = page.text.trim();
    if (!text) continue;
    if (text.length <= AI_CHUNK_TARGET_CHARS) {
      chunks.push({ pageNumber: page.pageNumber, chunkIndex: chunks.length, text, tokenCount: estimateTokens(text) });
      continue;
    }
    // split into paragraphs
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const pieces: string[] = [];
    let current = "";
    const pushCurrent = () => {
      if (current.trim()) pieces.push(current.trim());
      current = "";
    };
    for (const para of paragraphs) {
      if (para.length > AI_CHUNK_MAX_CHARS) {
        pushCurrent();
        // hard-split oversized paragraph on sentence boundaries
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if ((current + " " + sentence).trim().length > AI_CHUNK_TARGET_CHARS) {
            pushCurrent();
            current = sentence;
          } else {
            current = (current + " " + sentence).trim();
          }
          while (current.length > AI_CHUNK_MAX_CHARS) {
            pieces.push(current.slice(0, AI_CHUNK_MAX_CHARS));
            current = current.slice(AI_CHUNK_MAX_CHARS);
          }
        }
        pushCurrent();
      } else if ((current + "\n\n" + para).length > AI_CHUNK_TARGET_CHARS) {
        pushCurrent();
        current = para;
      } else {
        current = (current + "\n\n" + para).trim();
      }
    }
    pushCurrent();
    pieces.forEach((piece, i) => {
      chunks.push({ pageNumber: page.pageNumber, chunkIndex: chunks.length, text: piece, tokenCount: estimateTokens(piece) });
      void i; // chunkIndex is a running per-document index
    });
  }
  return chunks;
}
