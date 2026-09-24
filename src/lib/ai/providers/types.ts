// ============================================================
// AIProvider abstraction (spec §27).
//
// The application depends ONLY on this interface — never on a
// concrete model vendor. Adapters:
//   - HeuristicAIProvider  — local, deterministic baseline (active
//     default; no data leaves the host; no network dependency).
//   - ZaiAIProvider        — external LLM via z-ai-web-dev-sdk
//     (implemented; refuses while LOCAL_ONLY is on, spec §37).
//   - OpenAICompatibleProvider — interface seam documented for
//     production (NOT implemented — never claimed as live).
//
// STRUCTURED OUTPUT (spec §52): every method returns a typed
// result that the pipeline validates again before persistence.
// Malformed provider output raises AIOutputValidationError and is
// rejected (never persisted blindly).
// ============================================================

export const AI_PROVIDER_MODEL_NAMES: Record<string, { name: string; version: string }> = {
  heuristic: { name: "rule-baseline-v1", version: "1.0.0" },
  zai: { name: "glm-4.5-air", version: "2026-01" }, // external — only used when LOCAL_ONLY=false
};

/** Provider identity attached to every AI result (spec §40). */
export interface ModelProvenance {
  provider: string;
  modelName: string;
  modelVersion: string;
}

export interface ClassificationSuggestion {
  suggestedType: string;
  suggestedCategory?: string;
  confidence: number; // 0..1 — MODEL confidence, not factual/legal truth (spec §31)
  reason: string;
  sourceReference?: string;
}

export interface ExtractedEntityDraft {
  entityType: string; // AI_ENTITY_TYPES value — validated downstream
  originalText: string;
  normalizedValue?: string;
  pageNumber: number;
  startOffset?: number;
  endOffset?: number;
  confidence: number;
}

export interface SummaryDraft {
  summaryType: string; // AI_SUMMARY_TYPES value
  summaryText: string;
  sourceReferences: Array<{ pageNumber: number; quote: string }>;
}

export interface TimelineDraft {
  eventDate?: Date;
  eventDateText?: string;
  eventTime?: string;
  eventType: string; // AI_TIMELINE_EVENT_TYPES value
  description: string;
  pageNumber: number;
  confidence: number;
}

export interface SourcePage {
  pageNumber: number;
  text: string;
  /** Public DOC id — citations stay resolvable when pages span documents. */
  documentRef?: string;
}

export interface AnswerDraft {
  answerText: string;
  citations: Array<{ documentRef?: string; pageNumber: number; quote: string }>;
  sufficient: boolean; // false → NOT_FOUND_IN_AUTHORIZED_SOURCES path
}

export class AIOutputValidationError extends Error {
  readonly code = "AI_OUTPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "AIOutputValidationError";
  }
}

export interface AIProvider {
  readonly id: string;
  /** LOCAL_ONLY gate (spec §37): external providers report false. */
  readonly isExternal: boolean;
  provenance(): ModelProvenance;

  classifyDocument(input: { pages: SourcePage[]; currentType: string }): Promise<ClassificationSuggestion>;
  extractEntities(input: { pages: SourcePage[] }): Promise<ExtractedEntityDraft[]>;
  summarize(input: { pages: SourcePage[]; summaryType: string; documentTitle: string }): Promise<SummaryDraft>;
  extractTimeline(input: { pages: SourcePage[] }): Promise<TimelineDraft[]>;
  answerQuestion(input: {
    question: string;
    pages: SourcePage[]; // PRE-RETRIEVED, PRE-AUTHORIZED chunks/pages only
  }): Promise<AnswerDraft>;
}
