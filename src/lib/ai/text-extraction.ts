import { inflateRawSync } from "zlib";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { getOcrProvider, OcrLanguageUnavailableError, type OcrPageResult } from "./ocr";
import { detectLanguage, type LanguageDetection } from "./language";

// ============================================================
// DocumentTextExtractor (spec §6).
//
// Native text path:  DOCUMENT → text extraction → normalized text
// Scanned path:      DOCUMENT → page images → OCR → normalized text
//
// Formats (matching Phase 3's whitelist):
//   pdf  — pdftotext (poppler) for native text; when a page yields
//          (almost) no text it is rasterized with pdftoppm and sent
//          to the OCR provider (scanned-PDF detection per page).
//   txt/csv — direct decode.
//   png/jpeg/tiff — image → OCR provider.
//   docx — minimal ZIP reader (node zlib inflateRaw) over
//          word/document.xml. (DOCX is NOT in the upload whitelist
//          but extraction is kept for evidence archives that embed it.)
//
// Every page result preserves provenance: method, provider, page
// number, confidence (spec §6/§9). Extraction NEVER touches the
// original object bytes.
// ============================================================

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  extractionMethod: "NATIVE_TEXT" | "OCR";
  confidence: number | null;
  provider: string; // pdftotext | tesseract | utf8-decode | docx-xml
  modelVersion: string | null;
  language: LanguageDetection;
}

export interface ExtractionResult {
  pages: ExtractedPage[];
  ocrUsed: boolean;
  language: LanguageDetection; // document-level
  extractor: string;
  warnings: string[];
}

export class TextExtractionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TextExtractionError";
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** pdftotext per page — returns null when the binary is unavailable. */
function pdfNativePage(bytes: Buffer, pageNumber: number): string | null {
  const work = mkdtempSync(path.join(tmpdir(), `txt-${randomUUID().slice(0, 8)}-`));
  const pdfPath = path.join(work, "doc.pdf");
  try {
    writeFileSync(pdfPath, bytes);
    const res = spawnSync("pdftotext", ["-layout", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, "-"], {
      timeout: 60_000,
    });
    if (res.status !== 0) return "";
    return normalizeWhitespace(res.stdout.toString());
  } catch {
    return "";
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function pdfPageCount(bytes: Buffer): number {
  const work = mkdtempSync(path.join(tmpdir(), `pdf-${randomUUID().slice(0, 8)}-`));
  const pdfPath = path.join(work, "doc.pdf");
  try {
    writeFileSync(pdfPath, bytes);
    const res = spawnSync("pdfinfo", [pdfPath], { timeout: 30_000 });
    const m = res.stdout.toString().match(/Pages:\s+(\d+)/i);
    return m ? Math.min(parseInt(m[1], 10), 200) : 1; // hard cap: 200 pages per job (spec §55 limits)
  } catch {
    return 1;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** Rasterize one PDF page and OCR it. */
async function pdfOcrPage(bytes: Buffer, pageNumber: number, language: string): Promise<OcrPageResult | null> {
  const work = mkdtempSync(path.join(tmpdir(), `scan-${randomUUID().slice(0, 8)}-`));
  try {
    const pdfPath = path.join(work, "doc.pdf");
    writeFileSync(pdfPath, bytes);
    const res = spawnSync("pdftoppm", ["-png", "-r", "200", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, path.join(work, "page")], {
      timeout: 120_000,
    });
    if (res.status !== 0) return null;
    const produced = readdirSync(work).filter((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!produced.length) return null;
    const img: Buffer = readFileSync(path.join(work, produced[0]));
    const provider = getOcrProvider();
    return await provider.recognize({ bytes: img, language, pageNumber });
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** Minimal DOCX text reader: ZIP central parse + inflateRaw of word/document.xml. */
function docxText(bytes: Buffer): string {
  // locate End of Central Directory
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new TextExtractionError("AI_EXTRACTION_FAILED", "DOCX container is not a valid ZIP archive.");
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = eocd + 22; // skip fixed part + comment length
  offset += bytes.readUInt16LE(eocd + 20);
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length) break;
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compSize = bytes.readUInt32LE(offset + 20);
    const nameLen = bytes.readUInt16LE(offset + 28);
    const extraLen = bytes.readUInt16LE(offset + 30);
    const commentLen = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    // local file header
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) break;
    const lNameLen = bytes.readUInt16LE(localOffset + 26);
    const lExtraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    const xml = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    // extract <w:t> runs, paragraph breaks on <w:p>
    const paragraphs = xml.split(/<\/w:p>/).map((p) =>
      (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join("")
    );
    return normalizeWhitespace(paragraphs.filter((p) => p.trim()).join("\n\n"));
  }
  throw new TextExtractionError("AI_EXTRACTION_FAILED", "DOCX archive does not contain word/document.xml.");
}

export interface ExtractOptions {
  mimeType: string;
  fileExtension: string;
  /** Preferred OCR language code (en|hi). */
  ocrLanguage?: string;
}

export const DocumentTextExtractor = {
  /**
   * Extract normalized text per page from a DECRYPTED document buffer.
   * Throws TextExtractionError with a safe code on failure.
   */
  async extract_text(bytes: Buffer, opts: ExtractOptions): Promise<ExtractionResult> {
    const warnings: string[] = [];
    const ext = opts.fileExtension.toLowerCase();
    const pages: ExtractedPage[] = [];

    if (ext === "txt" || ext === "csv" || opts.mimeType.startsWith("text/")) {
      const text = normalizeWhitespace(bytes.toString("utf8"));
      // page 0 = document-level (plain text has no page boundaries)
      pages.push({
        pageNumber: 0,
        text,
        extractionMethod: "NATIVE_TEXT",
        confidence: 1,
        provider: "utf8-decode",
        modelVersion: null,
        language: detectLanguage(text),
      });
    } else if (ext === "pdf" || opts.mimeType === "application/pdf") {
      const count = pdfPageCount(bytes);
      let ocrUsed = false;
      for (let p = 1; p <= count; p++) {
        const native = pdfNativePage(bytes, p) ?? "";
        if (native.replace(/\s/g, "").length >= 20) {
          pages.push({
            pageNumber: p,
            text: native,
            extractionMethod: "NATIVE_TEXT",
            confidence: 1,
            provider: "pdftotext",
            modelVersion: null,
            language: detectLanguage(native),
          });
          continue;
        }
        // Scanned page → OCR path (spec §6)
        ocrUsed = true;
        try {
          const ocr = await pdfOcrPage(bytes, p, opts.ocrLanguage || "eng");
          if (ocr && ocr.recognizedText.trim()) {
            pages.push({
              pageNumber: p,
              text: normalizeWhitespace(ocr.recognizedText),
              extractionMethod: "OCR",
              confidence: ocr.confidence,
              provider: "tesseract",
              modelVersion: ocr.modelVersion,
              language: detectLanguage(ocr.recognizedText),
            });
          } else {
            warnings.push(`Page ${p}: no text could be extracted (native or OCR).`);
          }
        } catch (err) {
          if (err instanceof OcrLanguageUnavailableError) {
            warnings.push(`Page ${p}: OCR language pack unavailable (${err.language}).`);
          } else {
            warnings.push(`Page ${p}: OCR failed.`);
          }
        }
      }
      if (pages.length === 0) {
        throw new TextExtractionError(
          "AI_EXTRACTION_FAILED",
          warnings.length ? "No text could be extracted from the PDF." : "The PDF contains no extractable text."
        );
      }
      const combined = combineDocLanguage(pages.map((p) => p.language));
      return { pages, ocrUsed, language: combined, extractor: ocrUsed ? "pdftotext+tesseract" : "pdftotext", warnings };
    } else if (["png", "jpg", "jpeg", "tif", "tiff"].includes(ext) || opts.mimeType.startsWith("image/")) {
      try {
        const provider = getOcrProvider();
        const ocr = await provider.recognize({ bytes, language: opts.ocrLanguage || "eng", pageNumber: 1 });
        pages.push({
          pageNumber: 1,
          text: normalizeWhitespace(ocr.recognizedText),
          extractionMethod: "OCR",
          confidence: ocr.confidence,
          provider: "tesseract",
          modelVersion: ocr.modelVersion,
          language: detectLanguage(ocr.recognizedText),
        });
        if (!ocr.recognizedText.trim()) {
          warnings.push("No text recognized in the image.");
        }
      } catch (err) {
        if (err instanceof OcrLanguageUnavailableError) {
          throw new TextExtractionError("AI_LANGUAGE_PACK_UNAVAILABLE", err.message);
        }
        throw new TextExtractionError("AI_EXTRACTION_FAILED", "Image OCR failed.");
      }
    } else if (ext === "docx" || opts.mimeType.includes("wordprocessingml")) {
      const text = docxText(bytes);
      pages.push({
        pageNumber: 0,
        text,
        extractionMethod: "NATIVE_TEXT",
        confidence: 1,
        provider: "docx-xml",
        modelVersion: null,
        language: detectLanguage(text),
      });
    } else {
      throw new TextExtractionError("AI_EXTRACTION_FAILED", `Text extraction is not supported for ${ext || opts.mimeType} documents.`);
    }

    return {
      pages,
      ocrUsed: pages.some((p) => p.extractionMethod === "OCR"),
      language: combineDocLanguage(pages.map((p) => p.language)),
      extractor: pages[0]?.provider || "unknown",
      warnings,
    };
  },

  extract_pages(bytes: Buffer, opts: ExtractOptions): Promise<ExtractionResult> {
    return this.extract_text(bytes, opts);
  },

  detect_language(text: string): LanguageDetection {
    return detectLanguage(text);
  },
};

function combineDocLanguage(detections: LanguageDetection[]): LanguageDetection {
  const counts = new Map<string, number>();
  let weightedConf = 0;
  for (const d of detections) {
    counts.set(d.language, (counts.get(d.language) || 0) + 1);
    weightedConf += d.confidence;
  }
  const total = Math.max(detections.length, 1);
  let best = "LOW_CONFIDENCE";
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  const ratio = bestCount / total;
  if (best === "LOW_CONFIDENCE" || ratio < 0.5) {
    const hasLatin = detections.some((d) => d.language === "EN");
    const hasDev = detections.some((d) => d.language === "HI");
    if (hasLatin && hasDev) return { language: "MIXED", confidence: 0.6, detectionMethod: "per-page votes" };
    return { language: "LOW_CONFIDENCE", confidence: 0.35, detectionMethod: "per-page votes (inconclusive)" };
  }
  return {
    language: best,
    confidence: Math.round(Math.min(0.99, (weightedConf / total) * 0.7 + ratio * 0.3) * 100) / 100,
    detectionMethod: "per-page votes",
  };
}
