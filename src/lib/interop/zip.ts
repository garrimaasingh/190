import { inflateRawSync } from "zlib";
import { createHash } from "crypto";

// ============================================================
// Phase 9 — dependency-free ZIP layer (§2/§25/§26/§27).
//
// WRITER: store-only (method 0), fixed DOS timestamps, no extra
// fields → byte-deterministic output for identical entries, which
// makes the raw-archive SHA-256 a stable duplicate-detection key.
//
// READER: parses the End-of-Central-Directory + central directory
// FIRST and enforces every security limit on DECLARED values
// before inflating anything — archive bombs are rejected without
// decompressing a byte (§69/§78 "never load a multi-GB package").
// Only methods 0 (store) and 8 (deflate) are accepted; encrypted
// entries, zip64, data-descriptor-only entries, symlinks and
// non-regular files are refused. Paths are normalized and must be
// package-relative (§26 zip-slip).
// ============================================================

export class ZipFormatError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ZipFormatError";
  }
}

// ---------- CRC32 (needed by both directions) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------- deterministic writer ----------

export interface ZipEntryInput {
  path: string;
  data: Buffer;
}

/**
 * Fixed DOS timestamp (1980-01-01 00:00:00) — ZIP has no UTC-safe
 * timestamp, and determinism (§14) matters more than mtime fidelity.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // day=1, month=1, year=0 (1980)

export function buildZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length === 0) throw new ZipFormatError("ZIP_EMPTY", "Refusing to build an empty archive.");
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) throw new ZipFormatError("ZIP_DUPLICATE_PATH", `Duplicate entry path: ${e.path}`);
    seen.add(e.path);
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 — no zip64)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed (store)
    local.writeUInt32LE(size, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs: regular file, mode 0600-ish
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + size;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDir, end]);
}

// ---------- validating reader ----------

export interface ZipEntry {
  path: string;
  data: Buffer;
  declaredSha256?: string; // filled by caller if it wants to cross-check
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
}

export interface ZipSecurityLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxCompressionRatio: number;
  maxDepth: number;
}

/**
 * Normalize + validate a package-relative path (§26).
 * Rejects: absolute paths, drive letters, backslash traversal,
 * `..` segments, NUL bytes, empty names, trailing slashes
 * (directories are not part of the package format), and paths
 * deeper than the nesting limit.
 */
export function normalizePackagePath(rawName: string, maxDepth: number): string {
  if (rawName.includes("\0")) throw new ZipFormatError("ZIP_PATH_NUL", "Entry path contains a NUL byte.");
  // ZIP spec stores forward slashes; backslashes are treated as
  // separators by some legacy tools — treat any backslash as unsafe
  // input rather than trying to outsmart it (§26 `..\..\file`).
  if (rawName.includes("\\")) throw new ZipFormatError("ZIP_PATH_BACKSLASH", `Entry path contains a backslash: ${rawName.slice(0, 64)}`);
  if (rawName.startsWith("/")) throw new ZipFormatError("ZIP_PATH_ABSOLUTE", `Entry path is absolute: ${rawName.slice(0, 64)}`);
  if (/^[a-zA-Z]:/.test(rawName)) throw new ZipFormatError("ZIP_PATH_DRIVE", `Entry path has a drive letter: ${rawName.slice(0, 64)}`);

  const segments = rawName.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) throw new ZipFormatError("ZIP_PATH_EMPTY", "Entry path is empty.");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ZipFormatError("ZIP_PATH_TRAVERSAL", `Entry path contains dot/dotdot segment: ${rawName.slice(0, 64)}`);
  }
  if (segments.length > maxDepth) {
    throw new ZipFormatError("ZIP_PATH_DEPTH", `Entry path exceeds nesting depth ${maxDepth}: ${rawName.slice(0, 64)}`);
  }
  return segments.join("/");
}

function findEOCD(buf: Buffer): number {
  // Search the last 64KB + 22 bytes for the EOCD signature (comment may exist).
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipFormatError("ZIP_NOT_ARCHIVE", "Uploaded file is not a ZIP archive (no end-of-central-directory record).");
}

function parseCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEOCD(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // zip64 markers are refused: the platform's own writer never produces
  // them and 32-bit sizes are far above the configured limits anyway.
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipFormatError("ZIP64_UNSUPPORTED", "ZIP64 archives are not supported.");
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipFormatError("ZIP_CORRUPT", "Central directory extends past the end of the archive.");
  }

  const entries: CentralEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new ZipFormatError("ZIP_CORRUPT", "Central directory entry is corrupt.");
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset, externalAttrs });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Secure extraction (§25-§27). Every limit is checked against the
 * central directory BEFORE any inflation happens. Returns normalized
 * entries; the caller decides what to do with each payload.
 */
export function readZipSecure(buf: Buffer, limits: ZipSecurityLimits): ZipEntry[] {
  if (buf.length > limits.maxCompressedBytes) {
    throw new ZipFormatError("ARCHIVE_TOO_LARGE", `Archive exceeds the maximum compressed size (${limits.maxCompressedBytes} bytes).`);
  }
  const central = parseCentralDirectory(buf);

  if (central.length === 0) throw new ZipFormatError("ZIP_EMPTY", "Archive contains no entries.");
  if (central.length > limits.maxFiles) {
    throw new ZipFormatError("ARCHIVE_TOO_MANY_FILES", `Archive declares ${central.length} entries; maximum is ${limits.maxFiles}.`);
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  const seen = new Set<string>();
  for (const e of central) {
    const normalized = normalizePackagePath(e.name, limits.maxDepth);
    if (seen.has(normalized)) throw new ZipFormatError("ZIP_DUPLICATE_PATH", `Duplicate entry after normalization: ${normalized}`);
    seen.add(normalized);

    if (e.flags & 0x1) throw new ZipFormatError("ZIP_ENCRYPTED", `Encrypted entry refused: ${normalized}`);
    if (e.flags & 0x8 && e.compressedSize === 0 && e.uncompressedSize === 0) {
      throw new ZipFormatError("ZIP_DATA_DESCRIPTOR", `Entry without declared sizes refused: ${normalized}`);
    }
    if (e.method !== METHOD_STORE && e.method !== METHOD_DEFLATE) {
      throw new ZipFormatError("ZIP_METHOD_UNSUPPORTED", `Entry uses unsupported compression method ${e.method}: ${normalized}`);
    }
    // Symlink / non-regular detection via external attrs (unix: S_IFLNK = 0xA000).
    if ((e.externalAttrs >>> 16) & 0xa000) {
      throw new ZipFormatError("ZIP_SYMLINK", `Symlink entries are refused: ${normalized}`);
    }
    if (e.uncompressedSize > limits.maxFileBytes) {
      throw new ZipFormatError("ARCHIVE_BOMB_FILE", `Entry declares ${e.uncompressedSize} bytes; per-file maximum is ${limits.maxFileBytes}: ${normalized}`);
    }
    totalUncompressed += e.uncompressedSize;
    totalCompressed += e.compressedSize;
  }

  if (totalUncompressed > limits.maxUncompressedBytes) {
    throw new ZipFormatError("ARCHIVE_BOMB_TOTAL", `Archive declares ${totalUncompressed} uncompressed bytes; maximum is ${limits.maxUncompressedBytes}.`);
  }
  if (totalCompressed > 0 && totalUncompressed / Math.max(totalCompressed, 1) > limits.maxCompressionRatio) {
    throw new ZipFormatError("ARCHIVE_BOMB_RATIO", `Archive compression ratio exceeds ${limits.maxCompressionRatio}:1.`);
  }

  // ---- only now touch entry payloads ----
  return central.map((e) => {
    const localOffset = e.localOffset;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipFormatError("ZIP_CORRUPT", `Local header missing for entry: ${e.name.slice(0, 64)}`);
    }
    const nameLen = buf.readUInt16LE(localOffset + 26);
    const extraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + e.compressedSize;
    if (dataEnd > buf.length) throw new ZipFormatError("ZIP_CORRUPT", `Entry payload extends past archive end: ${e.name.slice(0, 64)}`);
    const payload = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (e.method === METHOD_STORE) {
      data = Buffer.from(payload); // copy — subarray keeps the whole archive alive
    } else {
      const inflated = inflateRawSync(payload, { maxOutputLength: limits.maxFileBytes });
      if (inflated.length !== e.uncompressedSize) {
        throw new ZipFormatError("ZIP_SIZE_MISMATCH", `Inflated size does not match the declared size: ${e.name.slice(0, 64)}`);
      }
      data = inflated;
    }

    // CRC verification — detects truncated/corrupted archives.
    if (crc32(data) !== buf.readUInt32LE(localOffset + 14)) {
      throw new ZipFormatError("ZIP_CRC_MISMATCH", `CRC check failed for entry: ${e.name.slice(0, 64)}`);
    }

    return { path: normalizePackagePath(e.name, limits.maxDepth), data };
  });
}
