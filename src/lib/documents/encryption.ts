import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { DOCUMENT_KEY_REFERENCE } from "@/lib/constants";

// ============================================================
// DocumentEncryptionService (spec §18/§19/§85).
//
// AES-256-GCM authenticated encryption — an established scheme
// from Node's audited crypto module, NOT custom cryptography.
//
// Wire format:  ENC1 | iv(12) | authTag(16) | ciphertext
//
// KEY MANAGEMENT (spec §19): key material comes from the
// environment (development-safe provider). Keys are NEVER stored
// alongside document data; only a non-secret keyReference (version
// label) is persisted on the document row. Production KMS/Vault
// integration is future work — this module is the seam (encrypt/
// decrypt/generate_key_reference stay stable).
//
// NOTE: intentionally dependency-free (plain Errors, no Next.js
// imports) so seed/maintenance scripts can reuse the exact same
// crypto pipeline as the API layer.
// ============================================================

const MAGIC = Buffer.from("ENC1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function loadKey(): Buffer {
  const hex = process.env.DOCUMENT_ENCRYPTION_KEY || "";
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    // Fail closed: refuse to store/serve documents with an unconfigured key.
    throw new Error("DOCUMENT_ENCRYPTION_KEY_MISSING");
  }
  return key;
}

export interface EncryptedBlob {
  blob: Buffer;
  keyReference: string;
}

export function encryptDocument(plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    blob: Buffer.concat([MAGIC, iv, tag, ciphertext]),
    keyReference: DOCUMENT_KEY_REFERENCE,
  };
}

/** Throws when authentication fails (tampered/mismatched key) — fail closed. */
export function decryptDocument(blob: Buffer): Buffer {
  if (blob.length < MAGIC.length + IV_LENGTH + TAG_LENGTH || !blob.subarray(0, 4).equals(MAGIC)) {
    throw new Error("DOCUMENT_BLOB_FORMAT_UNRECOGNIZED");
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = blob.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * generate_key_reference() — non-secret key version label. A new
 * key version (e.g. after KMS rotation) yields a new reference so
 * historical documents remain decryptable by their own version.
 */
export function generateKeyReference(): string {
  return `KEY-${createHash("sha256").update(loadKey()).digest("hex").slice(0, 12).toUpperCase()}`;
}
