import { decryptDocument, encryptDocument } from "@/lib/documents/encryption";

// ============================================================
// Phase 9 — pluggable package encryption service (§49/§50).
//
// WHAT IS ACTIVE: packages are encrypted AT REST in temporary
// secure storage with the SAME AES-256-GCM provider and key
// lifecycle the Phase 3 document store uses (ENC1|iv|tag|ct wire
// format via src/lib/documents/encryption — one key lifecycle,
// no parallel crypto). Package downloads decrypt server-side
// over an authenticated, authorized channel.
//
// WHAT IS NOT ACTIVE: end-to-end / recipient-based package
// encryption (public-key envelopes). Until that exists the
// package must be transferred only through approved secure
// channels, and every UI surface carries that instruction (§49).
// Package passwords must NEVER travel in the same channel as the
// package and are never stored in database logs (§50) — no
// password-protected archive support is claimed in this
// deployment.
// ============================================================

export interface PackageEncryptionResult {
  payload: Buffer;
  keyReference: string | null;
}

export interface PackageEncryptionService {
  readonly name: string;
  readonly atRestEnabled: boolean;
  encryptPackage(plain: Buffer): Promise<PackageEncryptionResult>;
  decryptPackage(payload: Buffer, keyReference: string | null): Promise<Buffer>;
}

class AtRestAesGcmPackageEncryption implements PackageEncryptionService {
  readonly name = "aes-256-gcm-at-rest (Phase 3 provider)";
  readonly atRestEnabled = true;

  async encryptPackage(plain: Buffer): Promise<PackageEncryptionResult> {
    const { blob, keyReference } = encryptDocument(plain);
    return { payload: blob, keyReference };
  }

  async decryptPackage(payload: Buffer, _keyReference: string | null): Promise<Buffer> {
    // Delegates to the Phase 3 decryption path — fail closed on
    // tampering or key mismatch (GCM auth failure throws).
    return decryptDocument(payload);
  }
}

export const packageEncryptionService: PackageEncryptionService = new AtRestAesGcmPackageEncryption();
