import {
  AI_PROVIDER_MODEL_NAMES,
  type AIProvider,
  type AnswerDraft,
  type ClassificationSuggestion,
  type ExtractedEntityDraft,
  type ModelProvenance,
  type SourcePage,
  type SummaryDraft,
  type TimelineDraft,
} from "./types";

// ============================================================
// HeuristicAIProvider — LOCAL deterministic baseline (spec §27).
//
// HONESTY LABEL: this is a rule-based NLP baseline, NOT a neural
// model. It gives the platform a fully-local, dependency-free,
// reproducible intelligence layer (and keeps the test suite
// deterministic). Every result it produces is stored with
// provider="heuristic" so provenance is always visible (spec §40),
// and the UI labels such results "Heuristic baseline model".
//
// What it really does:
//  - classifyDocument: weighted keyword/structure scoring against
//    the DOCUMENT_TYPES registry.
//  - extractEntities: regex + gazetteer + contextual heuristics
//    (dates, phones, emails, platform IDs, FIR numbers, legal
//    sections, vehicles, IMEI/serials, persons near role words,
//    organizations by suffix, locations by gazetteer/prepositions).
//  - summarize: extractive sentence scoring (term density +
//    position + length normalization) — sentences are quoted
//    verbatim from the source, so summaries cannot invent facts.
//  - extractTimeline: date-mention sentences classified by verb
//    patterns into the timeline event registry.
//  - answerQuestion: strictly extractive — answers are composed
//    ONLY of retrieved sentences with page citations; when nothing
//    relevant is found it reports "insufficient" and the pipeline
//    returns NOT_FOUND_IN_AUTHORIZED_SOURCES (spec §53).
// ============================================================

const PROV = AI_PROVIDER_MODEL_NAMES.heuristic;

// ---- classification knowledge base -----------------------------------
const CLASSIFIERS: Array<{
  type: string;
  category: string;
  strong: string[];
  weak: string[];
}> = [
  {
    type: "FIR",
    category: "CASE_RECORD",
    strong: ["first information report", "fir number", "fir no", "complainant"],
    weak: ["police station", "complaint", "registered", "sections", "offence", "uc 174", "crpc"],
  },
  {
    type: "FORENSIC_REPORT",
    category: "FORENSIC",
    strong: ["forensic", "laboratory report", "fsl", "scientific examination"],
    weak: ["exhibit", "specimen", "analysis", "chemical", "findings", "examination of", "sample", "report no"],
  },
  {
    type: "WITNESS_STATEMENT",
    category: "INVESTIGATION",
    strong: ["witness statement", "statement of witness", "i hereby state"],
    weak: ["witness", "deposition", "i saw", "i heard", "statement recorded"],
  },
  {
    type: "INVESTIGATION_REPORT",
    category: "INVESTIGATION",
    strong: ["investigation report", "case diary"],
    weak: ["investigation", "investigating officer", "enquiry", "seized", "seizure memo", "findings"],
  },
  {
    type: "COURT_ORDER",
    category: "JUDICIAL",
    strong: ["court order", "ordered that", "hon'ble court", "honorable court"],
    weak: ["court", "hearing", "judge", "petition", "directions"],
  },
  {
    type: "JUDGMENT",
    category: "JUDICIAL",
    strong: ["judgment", "convicted", "acquitted", "sentenced"],
    weak: ["court", "accused", "prosecution", "verdict"],
  },
  {
    type: "CHARGE_SHEET",
    category: "PROSECUTION",
    strong: ["charge sheet", "chargesheet", "final report"],
    weak: ["accused", "sections", "witnesses list", "offence"],
  },
  {
    type: "CASE_DIARY",
    category: "INVESTIGATION",
    strong: ["case diary", "diary entry"],
    weak: ["date of occurrence", "action taken", "io"],
  },
  {
    type: "IDENTITY_DOCUMENT",
    category: "IDENTIFICATION",
    strong: ["aadhaar", "aadhar", "identity card", "date of birth"],
    weak: ["gender", "s/o", "d/o", "address", "name:", "id no"],
  },
  {
    type: "LEGAL_NOTICE",
    category: "CORRESPONDENCE",
    strong: ["legal notice", "take notice", "demand notice"],
    weak: ["notice", "whereas", "advocate"],
  },
  {
    type: "CORRESPONDENCE",
    category: "CORRESPONDENCE",
    strong: ["dear sir", "subject:", "yours faithfully", "yours sincerely"],
    weak: ["letter", "regards", "reference", "kindly"],
  },
  {
    type: "EVIDENCE_REPORT",
    category: "FORENSIC",
    strong: ["evidence report", "chain of custody", "seizure list"],
    weak: ["evidence", "recovered", "sealed", "parcel"],
  },
];

// ---- tokenization helpers -------------------------------------------
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;
const WORD = /[A-Za-z0-9'\u0900-\u097F]+/g;

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function topTerms(pages: SourcePage[], take: number): Map<string, number> {
  const freq = new Map<string, number>();
  for (const page of pages) {
    for (const w of page.text.toLowerCase().match(WORD) || []) {
      if (w.length < 3) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return new Map([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, take));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ---- date parsing (Indian + ISO formats) -----------------------------
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const DATE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => { date: Date; text: string } | null }> = [
  {
    // 15 January 2026 / 15 Jan 2026
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/,
    build: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      if (!month) return null;
      const day = parseInt(m[1], 10);
      const year = parseInt(m[3], 10);
      if (day < 1 || day > 31) return null;
      return { date: new Date(Date.UTC(year, month - 1, day)), text: m[0] };
    },
  },
  {
    // January 15, 2026
    re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/,
    build: (m) => {
      const month = MONTHS[m[1].toLowerCase()];
      if (!month) return null;
      const day = parseInt(m[2], 10);
      if (day < 1 || day > 31) return null;
      return { date: new Date(Date.UTC(parseInt(m[3], 10), month - 1, day)), text: m[0] };
    },
  },
  {
    // 15/01/2026 · 15-01-2026 (Indian day-first convention)
    re: /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/,
    build: (m) => {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      return { date: new Date(Date.UTC(parseInt(m[3], 10), month - 1, day)), text: m[0] };
    },
  },
  {
    // 2026-01-15 (ISO)
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    build: (m) => {
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { date: new Date(Date.UTC(parseInt(m[1], 10), month - 1, day)), text: m[0] };
    },
  },
];

export function parseDateMention(text: string): { date: Date; text: string } | null {
  for (const p of DATE_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const built = p.build(m);
      if (built) return built;
    }
  }
  return null;
}

const QUESTION_STOPWORDS = new Set([
  "what", "who", "whom", "whose", "when", "where", "why", "how", "the", "and", "for", "was", "were", "has",
  "have", "had", "with", "from", "that", "this", "there", "their", "his", "her", "its", "are", "did", "does",
  "about", "into", "which", "you", "your", "can", "could", "would", "tell",
]);

// ---- timeline verb classification ------------------------------------
const TIMELINE_VERBS: Array<[RegExp, string]> = [
  [/\bfir\b|first information report|was registered| lodged\b/i, "FIR"],
  [/\bseized|seizure|seizing\b/i, "SEIZURE"],
  [/\barrest(ed|ed the|ting)?\b/i, "ARREST"],
  [/\bsearch(ed| warrant)?\b/i, "SEARCH"],
  [/\bcomplaint\b/i, "COMPLAINT"],
  [/\bforensic|examin(ed|ation) (of|the)|lab report|fsl\b/i, "FORENSIC_EXAMINATION"],
  [/\bcourt hearing|hearing (was|is) held|adjourned|next hearing\b/i, "COURT_HEARING"],
  [/\bcourt (order|directed|granted)\b|\border dated\b/i, "COURT_ORDER"],
  [/\btransfer(red|ring)?\b/i, "TRANSFER"],
  [/\bstatement (was )?recorded|witness statement\b/i, "CASE_EVENT"],
  [/\breport (was )?(submitted|forwarded|filed)\b|charge ?sheet (was )?filed\b/i, "DOCUMENT_SUBMITTED"],
  [/\bincident (occurred|happened|took place)|accident took place\b/i, "INCIDENT"],
];

function classifyTimelineSentence(sentence: string): string {
  for (const [re, type] of TIMELINE_VERBS) {
    if (re.test(sentence)) return type;
  }
  return "OTHER";
}

// ---- entity patterns ---------------------------------------------------
interface EntityPattern {
  type: string;
  re: RegExp;
  confidence: number;
  normalize?: (m: RegExpExecArray) => string | undefined;
}

const ENTITY_PATTERNS: EntityPattern[] = [
  { type: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, confidence: 0.98, normalize: (m) => m[0].toLowerCase() },
  {
    type: "PHONE_NUMBER",
    re: /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b|\b0\d{2,4}[\s-]\d{6,8}\b/g,
    confidence: 0.85,
    normalize: (m) => m[0].replace(/[\s-]/g, ""),
  },
  {
    type: "CASE_NUMBER",
    re: /\bCASE-[A-Z]{2}-[A-Z]{3}-\d{4}-\d{6}\b/g,
    confidence: 0.99,
    normalize: (m) => m[0].toUpperCase(),
  },
  {
    type: "EVIDENCE_ID",
    re: /\bEVD-[A-Z]{2}-[A-Z]{3}-\d{4}-\d{6}\b/g,
    confidence: 0.99,
    normalize: (m) => m[0].toUpperCase(),
  },
  {
    type: "DOCUMENT_NUMBER",
    re: /\bDOC-[A-Z]{2}-[A-Z]{3}-\d{4}-\d{6}\b/g,
    confidence: 0.99,
    normalize: (m) => m[0].toUpperCase(),
  },
  {
    type: "FIR_NUMBER",
    re: /\bFIR\s*(?:No\.?|Number|#)?\s*[:\-]?\s*\d{1,6}\s*(?:\/\s*\d{2,4})?\b|\bFIR\s*\/\s*\d{1,6}\s*\/\s*\d{2,4}\b/gi,
    confidence: 0.9,
    normalize: (m) => m[0].toUpperCase().replace(/\s+/g, " ").trim(),
  },
  {
    type: "LEGAL_SECTION",
    re: /\b(?:U\/S|under section|section|sections)\s+\d{1,3}[A-Z]?(?:\s*\([A-Za-z0-9]+\))?(?:\s*(?:of\s*)?(?:IPC|BNS|CrPC|BNSS|IT Act|NDPS))?/gi,
    confidence: 0.8,
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    type: "VEHICLE",
    re: /\b[A-Z]{2}\s?[-–]?\s?\d{1,2}\s?[-–]?\s?[A-Z]{1,3}\s?[-–]?\s?\d{3,4}\b/g,
    confidence: 0.82,
    normalize: (m) => m[0].replace(/[\s–-]/g, "").toUpperCase(),
  },
  {
    type: "DEVICE",
    re: /\bIMEI[:\s#]*\d{15}\b|\bserial(?:\s+number)?[:\s#]*[A-Z0-9]{6,16}\b/gi,
    confidence: 0.9,
    normalize: (m) => m[0].replace(/^(IMEI|Serial(?:\s+number)?)[:\s#]*\s*/i, "").toUpperCase(),
  },
  {
    type: "TIME",
    re: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:AM|PM|am|pm))?\b/g,
    confidence: 0.85,
    normalize: (m) => m[0].trim(),
  },
  {
    type: "PERSON",
    // title-cased multi-word names; verified contextually downstream
    re: /\b(?:Mr\.|Mrs\.|Ms\.|Shri|Smt\.|Dr\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b|\b(?:complainant|accused|witness|informant|suspect|constable|inspector|officer)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    confidence: 0.72,
    normalize: (m) =>
      m[0]
        .replace(/^(?:Mr\.|Mrs\.|Ms\.|Shri|Smt\.|Dr\.|complainant|accused|witness|informant|suspect|constable|inspector|officer)\s*/i, "")
        .trim(),
  },
  {
    type: "ORGANIZATION",
    re: /\b[A-Z][A-Za-z&. ]{2,40}?\s*(?:Pvt\.?\s?Ltd\.?|Private Limited|Limited|Corporation|Laboratory|Laboratories|Hospital|University|Technologies|Enterprises|Industries)\b|\b[A-Z][A-Za-z&. ]{2,30}\s+Police Department\b/g,
    confidence: 0.78,
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    type: "POLICE_STATION",
    re: /\b[A-Z][A-Za-z. ]{2,30}\s+Police Station\b|\bPS\s+[A-Z][A-Za-z. ]{2,30}\b/g,
    confidence: 0.88,
    normalize: (m) => m[0].replace(/\s+/g, " ").replace(/^PS\s+/i, "").trim(),
  },
  {
    type: "FORENSIC_LAB",
    re: /\b(?:Regional\s+|State\s+|Central\s+)?Forensic Science Laboratory(?:\s+[A-Z][a-z]+)?|\bFSL\s+[A-Z][a-z]+\b/g,
    confidence: 0.92,
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    type: "COURT",
    re: /\b(?:Sessions Court|High Court|Supreme Court|District Court|Judicial Magistrate(?:\s+(?:First|Second)\s+Class)?|Court of [A-Z][A-Za-z. ]{2,40})\b/g,
    confidence: 0.88,
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    type: "DATE",
    re: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g,
    confidence: 0.9,
    normalize: (m) => parseDateMention(m[0])?.date.toISOString().slice(0, 10) || m[0],
  },
];

// Gazetteer: seeded Indian locations (extensible registry — the
// production system would load a proper gazetteer).
const LOCATION_GAZETTEER = [
  "Bhopal", "Indore", "Betma", "Depalpur", "Mumbai", "Delhi", "Nagpur", "Jabalpur",
  "Gwalior", "Ujjain", "Dewas", "Pithampur", "Rau", "Bengaluru", "Hyderabad", "Pune",
];

export const HeuristicAIProvider: AIProvider = {
  id: "heuristic",
  isExternal: false,

  provenance(): ModelProvenance {
    return { provider: "heuristic", modelName: PROV.name, modelVersion: PROV.version };
  },

  async classifyDocument({ pages }): Promise<ClassificationSuggestion> {
    const fullText = pages.map((p) => p.text).join("\n").toLowerCase();
    if (fullText.trim().length < 10) {
      return {
        suggestedType: "OTHER",
        confidence: 0.3,
        reason: "Document text too short for meaningful classification signals.",
      };
    }
    const scored = CLASSIFIERS.map((c) => {
      let score = 0;
      const matched: string[] = [];
      for (const s of c.strong) {
        const hits = fullText.split(s).length - 1;
        if (hits > 0) {
          score += 3 * Math.min(hits, 4);
          matched.push(s);
        }
      }
      for (const w of c.weak) {
        const hits = fullText.split(w).length - 1;
        if (hits > 0) {
          score += 1 * Math.min(hits, 6);
          if (matched.length < 4) matched.push(w);
        }
      }
      return { c, score, matched };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    const second = scored[1];
    if (!top || top.score === 0) {
      return {
        suggestedType: "OTHER",
        confidence: 0.3,
        reason: "No strong document-type signals were found in the text.",
      };
    }
    // Confidence from score margin: strong separation → high confidence.
    const margin = second ? top.score / (top.score + second.score) : 0.85;
    const density = Math.min(top.score / 12, 1);
    const confidence = clamp01(0.35 + 0.4 * margin + 0.25 * density);
    const firstPage = pages.find((p) => {
      const lower = p.text.toLowerCase();
      return top.matched.some((m) => lower.includes(m));
    });
    return {
      suggestedType: top.c.type,
      suggestedCategory: top.c.category,
      confidence: Math.round(confidence * 100) / 100,
      reason: `Document-type signals detected (${top.matched.slice(0, 3).join(", ")}) — rule-based heuristic scoring, not a neural model.`,
      sourceReference: firstPage ? `page ${firstPage.pageNumber}` : undefined,
    };
  },

  async extractEntities({ pages }): Promise<ExtractedEntityDraft[]> {
    const drafts: ExtractedEntityDraft[] = [];
    for (const page of pages) {
      const text = page.text;
      for (const pattern of ENTITY_PATTERNS) {
        pattern.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.re.exec(text)) !== null) {
          const original = m[0].trim();
          if (original.length < 2) continue;
          let normalized: string | undefined;
          try {
            normalized = pattern.normalize?.(m);
          } catch {
            normalized = undefined;
          }
          // PERSON requires a capitalized full name after normalization
          if (pattern.type === "PERSON") {
            if (!/^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(normalized || original)) continue;
          }
          drafts.push({
            entityType: pattern.type,
            originalText: original,
            normalizedValue: normalized,
            pageNumber: page.pageNumber,
            startOffset: m.index,
            endOffset: m.index + original.length,
            confidence: pattern.confidence,
          });
        }
      }
      // LOCATION via gazetteer + prepositional heuristic
      for (const loc of LOCATION_GAZETTEER) {
        const re = new RegExp(`\\b(?:in|at|from|near|of)\\s+${loc}\\b|\\b${loc}\\b`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          drafts.push({
            entityType: "LOCATION",
            originalText: loc,
            normalizedValue: loc,
            pageNumber: page.pageNumber,
            startOffset: m.index,
            endOffset: m.index + m[0].length,
            confidence: 0.7,
          });
        }
      }
    }
    // Dedupe identical (type, normalized/original, page) occurrences
    const seen = new Set<string>();
    const unique = drafts.filter((d) => {
      const key = `${d.entityType}|${(d.normalizedValue || d.originalText).toLowerCase()}|${d.pageNumber}|${d.startOffset ?? -1}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique;
  },

  async summarize({ pages, summaryType, documentTitle }): Promise<SummaryDraft> {
    const all: Array<{ page: number; sentence: string; index: number }> = [];
    for (const page of pages) {
      splitSentences(page.text).forEach((sentence, index) => {
        if (sentence.length >= 30) all.push({ page: page.pageNumber, sentence, index });
      });
    }
    if (all.length === 0) {
      return {
        summaryType,
        summaryText: "Insufficient text content was available to produce a meaningful summary.",
        sourceReferences: [],
      };
    }
    const terms = topTerms(pages, 18);
    const scored = all.map((item) => {
      const words = item.sentence.toLowerCase().match(WORD) || [];
      let score = 0;
      for (const w of words) score += terms.get(w) || 0;
      score = score / Math.max(words.length, 1);
      // position bias: early sentences carry framing content
      score += Math.max(0, 1 - item.index / Math.max(all.length, 1)) * 0.4;
      // length normalization: penalize very short and very long
      if (words.length < 8) score *= 0.5;
      if (words.length > 60) score *= 0.75;
      return { ...item, score };
    });
    const count =
      summaryType === "SHORT" ? Math.min(3, all.length) : summaryType === "EXECUTIVE" ? Math.min(4, all.length) : Math.min(8, all.length);
    const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, count).sort((a, b) => (a.page - b.page) || (a.index - b.index));
    const summaryText =
      `Extractive summary of "${documentTitle}" (heuristic baseline — sentences quoted from the source):\n` +
      chosen.map((c) => `- ${c.sentence}`).join("\n");
    return {
      summaryType,
      summaryText,
      sourceReferences: chosen.map((c) => ({
        pageNumber: c.page,
        quote: c.sentence.slice(0, 160),
      })),
    };
  },

  async extractTimeline({ pages }): Promise<TimelineDraft[]> {
    const drafts: TimelineDraft[] = [];
    for (const page of pages) {
      for (const sentence of splitSentences(page.text)) {
        const parsed = parseDateMention(sentence);
        if (!parsed) continue;
        const eventType = classifyTimelineSentence(sentence);
        if (eventType === "OTHER" && !/\b(on|dated|at)\b/i.test(sentence)) continue;
        const timeMatch = sentence.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:AM|PM))?\b/);
        drafts.push({
          eventDate: parsed.date,
          eventDateText: parsed.text,
          eventTime: timeMatch?.[0],
          eventType,
          description: sentence.slice(0, 240),
          pageNumber: page.pageNumber,
          confidence: eventType === "OTHER" ? 0.45 : 0.75,
        });
      }
    }
    return drafts;
  },

  async answerQuestion({ question, pages }): Promise<AnswerDraft> {
    // Strictly extractive: score sentences against QUESTION terms only.
    // Stopwords are excluded so generic filler ("what is the...") can
    // never ground an answer by itself (spec §53 no-hallucination).
    const qWords = new Set(
      (question.toLowerCase().match(WORD) || []).filter(
        (w) => w.length >= 3 && !QUESTION_STOPWORDS.has(w)
      )
    );
    if (qWords.size === 0) return { answerText: "", citations: [], sufficient: false };
    const candidates: Array<{ page: SourcePage; sentence: string; score: number }> = [];
    for (const page of pages) {
      for (const sentence of splitSentences(page.text)) {
        const words = sentence.toLowerCase().match(WORD) || [];
        if (words.length < 4) continue;
        let hits = 0;
        for (const w of words) if (qWords.has(w)) hits++;
        if (hits === 0) continue;
        candidates.push({ page, sentence, score: hits / Math.sqrt(words.length) });
      }
    }
    if (candidates.length === 0) {
      return { answerText: "", citations: [], sufficient: false };
    }
    const top = candidates.sort((a, b) => b.score - a.score).slice(0, 3);
    const answerText =
      "According to the authorized case records: " +
      top
        .map(
          (c) =>
            `"${c.sentence}" (${c.page.documentRef ? `${c.page.documentRef}, page ${c.page.pageNumber}` : `page ${c.page.pageNumber}`})`
        )
        .join(" ");
    return {
      answerText,
      citations: top.map((c) => ({
        documentRef: c.page.documentRef,
        pageNumber: c.page.pageNumber,
        quote: c.sentence.slice(0, 160),
      })),
      sufficient: true,
    };
  },
};
