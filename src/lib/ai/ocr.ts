import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";

// ============================================================
// OCRService (spec §7).
//
// Provider abstraction: OCRProvider interface + TesseractOcrProvider
// (the only ACTIVE provider). The architecture deliberately does
// NOT hard-code tesseract — additional engines/Indian languages
// plug into the same interface.
//
// HONEST LIMITATION (spec §7/§54/§R): the sandbox's tesseract
// installation carries ONLY the `eng` language pack. Requests for
// `hin` return AI_LANGUAGE_PACK_UNAVAILABLE instead of pretending
// to recognize Devanagari — the provider layer already accepts the
// language code for when the `hin` traineddata is installed.
//
// OCR output is DERIVED DATA. It never replaces the original file.
// ============================================================

export interface OcrPageResult {
  pageNumber: number;
  recognizedText: string;
  confidence: number | null;
  boundingBoxes: Array<{ word: string; x: number; y: number; w: number; h: number; conf: number }> | null;
  provider: string;
  modelVersion: string | null;
  language: string;
}

export interface OCRProvider {
  readonly id: string;
  readonly supportedLanguages: string[]; // advertised capability
  listInstalledLanguages(): Promise<string[]>;
  recognize(input: { bytes: Buffer; language: string; pageNumber: number }): Promise<OcrPageResult>;
}

export class OcrLanguageUnavailableError extends Error {
  readonly code = "AI_LANGUAGE_PACK_UNAVAILABLE";
  constructor(public readonly language: string, public readonly installed: string[]) {
    super(`OCR language pack "${language}" is not installed (installed: ${installed.join(", ") || "none"}).`);
    this.name = "OcrLanguageUnavailableError";
  }
}

function tesseractVersion(): string | null {
  const res = spawnSync("tesseract", ["--version"]);
  const out = res.stdout?.toString() || res.stderr?.toString() || "";
  return out.match(/tesseract(?:-v)?\s+v?(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

/** Tesseract 5 CLI provider. Runs the binary in a temp workspace. */
export const TesseractOcrProvider: OCRProvider = {
  id: "tesseract",
  supportedLanguages: ["eng", "hin"], // hin requires the hin.traineddata pack at runtime

  async listInstalledLanguages(): Promise<string[]> {
    const res = spawnSync("tesseract", ["--list-langs"]);
    if (res.status !== 0) return [];
    return (res.stdout?.toString() || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(List of available languages|Name|Version|\d+\.\d+)/i.test(l) && l !== "osd");
  },

  async recognize({ bytes, language, pageNumber }): Promise<OcrPageResult> {
    const installed = await this.listInstalledLanguages();
    const wanted = language.toLowerCase() === "hi" ? "hin" : language.toLowerCase() === "en" ? "eng" : language.toLowerCase();
    if (!installed.includes(wanted)) {
      throw new OcrLanguageUnavailableError(wanted, installed);
    }
    const work = mkdtempSync(path.join(tmpdir(), `ocr-${randomUUID().slice(0, 8)}-`));
    const inputPath = path.join(work, "page.bin");
    writeFileSync(inputPath, bytes);
    const res = spawnSync(
      "tesseract",
      [inputPath, path.join(work, "out"), "-l", wanted, "--psm", "3", "tsv"],
      { timeout: 120_000 }
    );
    try {
      const tsv = readFileSync(path.join(work, "out.tsv"), "utf8");
      const boxes: NonNullable<OcrPageResult["boundingBoxes"]> = [];
      let confSum = 0;
      let confCount = 0;
      for (const line of tsv.split("\n").slice(1)) {
        const cols = line.split("\t");
        if (cols.length < 12) continue;
        const conf = parseFloat(cols[10]);
        const word = cols[11];
        if (!word || !word.trim() || !Number.isFinite(conf) || conf < 0) continue;
        boxes.push({ word: word.slice(0, 60), x: +cols[6], y: +cols[7], w: +cols[8], h: +cols[9], conf: conf / 100 });
        confSum += conf;
        confCount++;
      }
      const recognizedText = boxes
        .map((b) => b.word)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        pageNumber,
        recognizedText,
        confidence: confCount ? Math.round((confSum / confCount) * 100) / 100 : null,
        boundingBoxes: boxes.length ? boxes.slice(0, 4000) : null,
        provider: "tesseract",
        modelVersion: tesseractVersion(),
        language: wanted,
      };
    } finally {
      // best-effort temp cleanup
      try {
        for (const f of readdirSync(work)) {
          rmSync(path.join(work, f), { force: true });
        }
      } catch {
        // ignore
      }
    }
  },
};

export function getOcrProvider(id?: string): OCRProvider {
  // Single active provider; the seam exists so additional engines
  // (indic OCR services, cloud vision) can be registered without
  // touching the pipeline.
  return TesseractOcrProvider;
}
