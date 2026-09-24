import {
  DOCUMENT_ALLOWED_EXTENSIONS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_SIZE_MB,
  ERROR_CODES,
} from "@/lib/constants";
import { ApiError } from "@/lib/api";

// ============================================================
// DocumentValidationService (spec §13/§14/§71).
//
// The browser declaration is NEVER trusted: the extension, the
// declared MIME and the DETECTED content type (magic bytes) must
// all agree before a file is accepted. Original filenames are
// sanitized for display/storage as metadata only — they are never
// concatenated into filesystem or storage paths (spec §44/§71).
// ============================================================

export interface FileValidationResult {
  /** Server-detected MIME type (magic bytes / decode). */
  mimeType: string;
  /** Normalized lowercase extension without dot. */
  fileExtension: string;
  /** Sanitized original filename (metadata only). */
  originalFilename: string;
  fileSize: number;
}

/** Control characters and path separators are stripped from metadata filenames. */
export function sanitizeOriginalFilename(name: string): string {
  // path traversal & separators & null bytes: never let any component through
  const base = name.split(/[\\/]/).pop() || "document";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "") // control chars incl. null byte
    .replace(/[^A-Za-z0-9._ ()\-\u0080-\uffff]/g, "_") // conservative display whitelist
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "document";
  return cleaned.slice(0, 180);
}

export function detectExtensionFromFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "";
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return "";
  return base.slice(idx + 1).toLowerCase();
}

// ---------- magic-byte detection (spec §13: file signature) ----------

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

/**
 * Detects the actual content type from bytes. Returns null when the
 * content matches no known signature — binary garbage is rejected,
 * and plain-text candidates are validated by decode + control scan.
 */
export function detectMimeType(buf: Buffer): string | null {
  if (buf.length === 0) return null;
  // PDF
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  // PNG
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // TIFF (little & big endian)
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  // UTF-8 text candidate: reject if decode fails or binary control chars dominate
  const sample = buf.subarray(0, 8192);
  const text = sample.toString("utf8");
  if (Buffer.compare(Buffer.from(text, "utf8"), sample) !== 0) return null; // not round-trippable UTF-8
  let suspicious = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 9 || (code > 13 && code < 32) || code === 127) suspicious++;
  }
  if (suspicious > 0) return null;
  return "text/plain"; // CSV is a text subtype; refined against the extension below
}

/**
 * Full validation pipeline (spec §13). Throws ApiError with a
 * specific, user-safe code. Every check is server-side.
 */
export function validateUploadedFile(input: {
  originalFilename: string;
  declaredMimeType: string | null | undefined;
  buffer: Buffer;
}): FileValidationResult {
  const { buffer } = input;

  // Empty file (spec §75)
  if (!buffer || buffer.length === 0) {
    throw new ApiError(422, ERROR_CODES.INVALID_FILE, "The uploaded file is empty.");
  }

  // Size limit (spec §14) — enforced server-side regardless of client hints
  if (buffer.length > DOCUMENT_MAX_BYTES) {
    throw new ApiError(
      413,
      ERROR_CODES.FILE_TOO_LARGE,
      `File exceeds the maximum allowed size of ${DOCUMENT_MAX_SIZE_MB} MB.`
    );
  }

  // Filename: sanitize for metadata; never used for storage paths (spec §17/§44)
  const originalFilename = sanitizeOriginalFilename(input.originalFilename || "document");

  // Extension whitelist (spec §13)
  const fileExtension = detectExtensionFromFilename(originalFilename);
  const extensionMime = DOCUMENT_ALLOWED_EXTENSIONS[fileExtension];
  if (!extensionMime) {
    throw new ApiError(
      415,
      ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      "Unsupported file extension. Allowed: PDF, PNG, JPEG, TIFF, TXT, CSV."
    );
  }

  // Declared MIME check — browsers may send generic octet-stream; anything
  // present must not contradict the extension family (spec §13).
  const declared = (input.declaredMimeType || "").split(";")[0].trim().toLowerCase();
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== extensionMime &&
    !(extensionMime === "text/csv" && declared === "text/plain") &&
    !(extensionMime === "text/plain" && declared === "text/csv")
  ) {
    throw new ApiError(
      415,
      ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      "The declared file type does not match the file extension."
    );
  }

  // Magic-byte detection (spec §13) — authoritative source of truth
  const detected = detectMimeType(buffer);
  if (!detected) {
    throw new ApiError(
      415,
      ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      "File content could not be identified as an allowed document format."
    );
  }
  // text/* detection refines to CSV by extension; everything else must match exactly
  const mimeType =
    detected === "text/plain" && (fileExtension === "csv" || declared === "text/csv")
      ? "text/csv"
      : detected;
  if (mimeType !== extensionMime) {
    throw new ApiError(
      415,
      ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      "File content does not match its extension (signature mismatch)."
    );
  }

  return { mimeType, fileExtension, originalFilename, fileSize: buffer.length };
}
