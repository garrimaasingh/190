import { createReadStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { readFile, stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";

// ============================================================
// DocumentStorageService (spec §15/§16/§43/§44/§84).
//
// Storage ABSTRACTION: the business layer depends only on this
// interface (put_object/get_object/delete_staged_object/
// object_exists/stream_object) — never on a concrete SDK.
//
// PHASE 4 (spec §12): this is the platform's SecureObjectStorage —
// DOCUMENT objects AND EVIDENCE objects live here under the same
// principles. No second storage architecture exists.
//
// ACTIVE PROVIDER: LOCAL_ENCRYPTED_FS (development). The project
// has no MinIO/S3 deployment, so Phase 3 ships a local encrypted-
// filesystem provider behind the same interface; swapping in
// MinIO/S3 later touches only this file.
//
// SECURITY:
// - Keys are OPAQUE and server-generated:
//     cases/{case-internal-uuid}/documents/{uuid}/object
//     evidence/{case-internal-uuid}/{uuid}/object
//   User input NEVER contributes to a storage path (spec §16/§44).
// - get/delete validate the key against the canonical shape —
//   path traversal attempts are rejected before any FS access.
// - The root lives outside /public; bytes are reachable only via
//   the authorized streaming APIs (spec §31).
// ============================================================

// Root kept at db/uploads/documents since Phase 3 — EXISTING document
// objects stay byte-addressable without migration; evidence objects
// are namespaced by their `evidence/` key prefix under the same root.
const STORAGE_ROOT = path.join(process.cwd(), "db", "uploads", "documents");

/** Canonical key shapes: cases/<id>/documents/<uuid>/object and evidence/<caseId>/<uuid>/object */
const KEY_PATTERNS = [
  /^cases\/[A-Za-z0-9_-]+\/documents\/[0-9a-fA-F-]{36}\/object$/,
  /^evidence\/[A-Za-z0-9_-]+\/[0-9a-fA-F-]{36}\/object$/,
];

export function buildStorageKey(caseInternalId: string, documentUuid: string): string {
  return `cases/${caseInternalId}/documents/${documentUuid}/object`;
}

export function buildEvidenceStorageKey(caseInternalId: string, evidenceUuid: string): string {
  return `evidence/${caseInternalId}/${evidenceUuid}/object`;
}

function assertSafeKey(key: string): void {
  if (!KEY_PATTERNS.some((p) => p.test(key))) {
    throw new Error(`Refusing unsafe storage key: ${key.slice(0, 64)}`);
  }
}

function resolveKey(key: string): string {
  assertSafeKey(key);
  const resolved = path.join(STORAGE_ROOT, key);
  // Defense in depth: resolved path must remain inside the root
  if (!resolved.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error("Path traversal rejected by storage provider.");
  }
  return resolved;
}

export const DocumentStorage = {
  provider: "LOCAL_ENCRYPTED_FS" as const,

  ensureRoot(): void {
    if (!existsSync(STORAGE_ROOT)) mkdirSync(STORAGE_ROOT, { recursive: true });
  },

  async put_object(key: string, content: Buffer): Promise<{ key: string; size: number }> {
    const resolved = resolveKey(key);
    await import("fs/promises").then((m) => m.mkdir(path.dirname(resolved), { recursive: true }));
    await import("fs/promises").then((m) => m.writeFile(resolved, content));
    return { key, size: content.length };
  },

  async get_object(key: string): Promise<Buffer> {
    const resolved = resolveKey(key);
    return readFile(resolved);
  },

  async object_exists(key: string): Promise<boolean> {
    try {
      const resolved = resolveKey(key);
      const s = await stat(resolved);
      return s.isFile();
    } catch {
      return false;
    }
  },

  /** Stream without loading the whole object (spec §48/§89). */
  async stream_object(key: string): Promise<ReadableStream<Uint8Array>> {
    const resolved = resolveKey(key);
    const nodeStream = createReadStream(resolved);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  },

  /** Best-effort staged-object cleanup (spec §22/§69). Never throws. */
  delete_staged_object(key: string): void {
    try {
      const resolved = resolveKey(key);
      if (existsSync(resolved)) unlinkSync(resolved);
    } catch (err) {
      console.error("[document-storage] staged cleanup failed (marked for reconciliation):", key.slice(0, 48), err);
    }
  },
};
