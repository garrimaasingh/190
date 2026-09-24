import { createHash } from "crypto";

// ============================================================
// DocumentIntegrityService (spec §20/§21/§86).
//
// SHA-256 over the PLAINTEXT content, calculated BEFORE encryption.
// The hash is the document's integrity fingerprint — immutable
// metadata usable later for evidence integrity, import
// verification, audit, ledger anchoring (Phase 4) and custody
// verification.
//
// It is NOT presented as a continuously running tamper-detection
// system: storage immutability is enforced by the authorization
// model (no mutation APIs exist). verifyDocumentIntegrity() is a
// controlled process (SYSTEM_ADMIN backend operation), not a
// user-facing "TAMPERED" badge.
// ============================================================

export function calculateSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface IntegrityCheckResult {
  recordedHash: string;
  computedHash: string;
  match: boolean;
}

export function verifyHash(content: Buffer, recordedHash: string): IntegrityCheckResult {
  const computedHash = calculateSha256(content);
  return { recordedHash: recordedHash.toLowerCase(), computedHash, match: computedHash === recordedHash.toLowerCase() };
}

/** Safe for large files: incremental hash over chunks (spec §89). */
export function calculateSha256Streaming(chunks: Buffer[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}
