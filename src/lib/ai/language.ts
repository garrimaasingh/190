// ============================================================
// LanguageDetectionService (spec §8).
//
// Initial support: English (Latin script) + Hindi (Devanagari) +
// Mixed. Method: script-ratio analysis + English stopword density.
// LOW_CONFIDENCE is returned when the text is too short or the
// signals are ambiguous — the system never silently assumes a
// language (spec §8).
// ============================================================

export interface LanguageDetection {
  language: string; // EN | HI | MIXED | LOW_CONFIDENCE
  confidence: number;
  detectionMethod: string;
}

const DEVANAGARI = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z]/g;

const EN_STOPWORDS = new Set([
  "the", "of", "and", "to", "in", "a", "is", "that", "for", "it", "on", "with", "as", "was", "at", "by",
  "an", "be", "this", "from", "or", "are", "were", "has", "have", "had", "not", "which", "their", "said",
]);

const HI_STOPWORDS_DEV = new Set([
  "का", "के", "की", "है", "में", "से", "और", "पर", "को", "यह", "एक", "ने", "भी", "कि", "हैं", "था", "थे",
]);

export function detectLanguage(text: string): LanguageDetection {
  const trimmed = text.trim();
  if (trimmed.length < 20) {
    return { language: "LOW_CONFIDENCE", confidence: 0.2, detectionMethod: "script-ratio+stopwords (text too short)" };
  }
  const devCount = (trimmed.match(DEVANAGARI) || []).length;
  const latinCount = (trimmed.match(LATIN) || []).length;
  const totalLetters = devCount + latinCount;
  if (totalLetters === 0) {
    return { language: "LOW_CONFIDENCE", confidence: 0.2, detectionMethod: "script-ratio (no letters)" };
  }
  const devRatio = devCount / totalLetters;
  const latinRatio = latinCount / totalLetters;

  if (devRatio > 0.6) {
    // Devanagari-dominant — boost confidence with Hindi stopword hits
    const words = trimmed.split(/\s+/).slice(0, 200);
    const hiHits = words.filter((w) => HI_STOPWORDS_DEV.has(w)).length;
    const confidence = Math.min(0.99, 0.7 + (hiHits / Math.max(words.length, 1)) * 2);
    return { language: "HI", confidence: Math.round(confidence * 100) / 100, detectionMethod: "script-ratio+stopwords" };
  }
  if (devRatio > 0.12 && latinRatio > 0.12) {
    return { language: "MIXED", confidence: Math.min(0.95, 0.6 + Math.min(devRatio, latinRatio)), detectionMethod: "script-ratio" };
  }
  if (latinRatio > 0.6) {
    const words = trimmed.toLowerCase().match(/[a-z']+/g) || [];
    const stopHits = words.filter((w) => EN_STOPWORDS.has(w)).length;
    const stopRatio = stopHits / Math.max(words.length, 1);
    if (stopRatio < 0.08 && words.length < 40) {
      return { language: "LOW_CONFIDENCE", confidence: 0.35, detectionMethod: "script-ratio+stopwords (weak stopword signal)" };
    }
    const confidence = Math.min(0.99, 0.6 + stopRatio * 1.6);
    return { language: "EN", confidence: Math.round(confidence * 100) / 100, detectionMethod: "script-ratio+stopwords" };
  }
  return { language: "LOW_CONFIDENCE", confidence: 0.3, detectionMethod: "script-ratio (ambiguous)" };
}

/** Combine per-page detections into a document-level label. */
export function combineDetections(detections: LanguageDetection[]): LanguageDetection {
  const counts = new Map<string, number>();
  for (const d of detections) counts.set(d.language, (counts.get(d.language) || 0) + 1);
  const total = Math.max(detections.length, 1);
  let best = "LOW_CONFIDENCE";
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount || (count === bestCount && lang === "MIXED")) {
      best = lang;
      bestCount = count;
    }
  }
  const ratio = bestCount / total;
  if (best === "LOW_CONFIDENCE" || ratio < 0.5) {
    // mixed pages → document-level MIXED when at least two script groups present
    const hasLatin = detections.some((d) => d.language === "EN");
    const hasDev = detections.some((d) => d.language === "HI");
    if (hasLatin && hasDev) return { language: "MIXED", confidence: 0.6, detectionMethod: "per-page votes" };
    return { language: "LOW_CONFIDENCE", confidence: 0.35, detectionMethod: "per-page votes (inconclusive)" };
  }
  return {
    language: best,
    confidence: Math.round(Math.min(0.99, 0.5 + ratio * 0.45) * 100) / 100,
    detectionMethod: "per-page votes",
  };
}
