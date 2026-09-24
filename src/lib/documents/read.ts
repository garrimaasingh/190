import { db } from "@/lib/db";
import { DocumentStorage } from "./storage";
import { decryptDocument } from "./encryption";

// ============================================================
// Authorized-object read helper — the ONLY sanctioned way for
// internal services (Phase 4 evidence storage, Phase 5 AI
// extraction) to obtain DECRYPTED document bytes.
//
// SECURITY: bytes are read in-memory only, never written to disk
// and never returned to clients. Callers must already enforce
// case + classification authorization before invoking this.
// ============================================================

export async function getDocumentObjectBytes(document: {
  storageKey: string;
  storageProvider: string;
  encryptionStatus: string;
}): Promise<Buffer> {
  const encrypted = await DocumentStorage.get_object(document.storageKey);
  if (document.encryptionStatus === "ENCRYPTED_AES_256_GCM") {
    return decryptDocument(encrypted);
  }
  // Unencrypted objects should not exist under the LOCAL_ENCRYPTED_FS
  // provider; return as-is only for defensive completeness.
  return encrypted;
}
