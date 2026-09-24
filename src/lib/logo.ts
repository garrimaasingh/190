import sharp from "sharp";
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { LOGO_MAX_BYTES, LOGO_MIN_DIM, LOGO_MAX_DIM } from "@/lib/constants";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";

// ============================================================
// Department logo pipeline (spec §8 / §47).
// Security controls:
//  - MIME declared by client is NOT trusted; magic bytes decide
//  - size limit enforced before decode
//  - dimensions validated via sharp decode
//  - image is re-encoded to PNG (strips EXIF/payload tricks)
//  - server-generated filename (UUID) — user filename ignored
//  - stored OUTSIDE /public; served only via API route that
//    validates the file id format → no arbitrary path access
// ============================================================

const LOGO_DIR = path.join(process.cwd(), "db", "uploads", "logos");
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export interface StoredLogo {
  storagePath: string;
  fileId: string;
  mime: string;
}

export async function validateAndStoreLogo(file: File): Promise<StoredLogo> {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Logo file is required.");
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new ApiError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, "Logo exceeds the 2 MB size limit.");
  }
  if (file.size === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Logo file is empty.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Magic-byte sniffing — content decides, not the client header
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebP =
    buffer.length > 12 &&
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP";

  if (!isPng && !isJpeg && !isWebP) {
    throw new ApiError(
      415,
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      "Logo must be a PNG, JPEG or WebP image."
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new ApiError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, "Logo file could not be decoded as an image.");
  }
  const w = metadata.width || 0;
  const h = metadata.height || 0;
  if (w < LOGO_MIN_DIM || h < LOGO_MIN_DIM || w > LOGO_MAX_DIM || h > LOGO_MAX_DIM) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_ERROR,
      `Logo dimensions must be between ${LOGO_MIN_DIM}px and ${LOGO_MAX_DIM}px.`
    );
  }

  // Re-encode to a normalized PNG — neutralizes polyglot/metadata attacks
  const normalized = await sharp(buffer)
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  const fileId = `${randomUUID()}.png`;
  await mkdir(LOGO_DIR, { recursive: true });
  const storagePath = path.join(LOGO_DIR, fileId);
  await writeFile(storagePath, normalized);

  return { storagePath, fileId, mime: "image/png" };
}

export async function readLogo(fileId: string): Promise<Buffer | null> {
  if (!FILE_ID_PATTERN.test(fileId)) return null; // blocks traversal / arbitrary reads
  try {
    const p = path.join(LOGO_DIR, fileId);
    // Defense in depth: resolved path must stay inside LOGO_DIR
    if (!path.resolve(p).startsWith(path.resolve(LOGO_DIR))) return null;
    return await readFile(p);
  } catch {
    return null;
  }
}

export async function deleteLogo(fileId: string | null): Promise<void> {
  if (!fileId || !FILE_ID_PATTERN.test(fileId)) return;
  try {
    await unlink(path.join(LOGO_DIR, fileId));
  } catch {
    // best-effort
  }
}
