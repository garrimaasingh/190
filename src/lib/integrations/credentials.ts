import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "crypto";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { dirname, join } from "path";
import { db } from "@/lib/db";

// ============================================================
// Phase 8 — Credential & secret abstraction (spec §7).
//
// RULES:
// - API keys / passwords / client secrets / private keys are NEVER
//   stored in the database, frontend code, git, logs or audit
//   metadata. The DB holds only a secret REFERENCE (§7).
// - The SecretStore interface is the seam for Vault / KMS / cloud
//   secret managers / government-approved stores. The default
//   development adapter encrypts blobs with AES-256-GCM under a
//   master key from the environment and stores them OUTSIDE the
//   database and the web root.
// - Plaintext exists in memory only for the duration of a provider
//   call and is never serialized into errors or logs.
// ============================================================

export interface SecretStore {
  put(ref: string, plaintext: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

function loadMasterKey(): Buffer {
  const hex = process.env.INTEGRATION_SECRET_MASTER_KEY || "";
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    // Fail closed — same posture as document encryption.
    throw new Error("INTEGRATION_SECRET_MASTER_KEY_MISSING");
  }
  return key;
}

const MAGIC = Buffer.from("ISC1"); // integration secret container v1

/**
 * Development SecretStore: AES-256-GCM encrypted blobs on the local
 * filesystem, outside the DB and outside /public. Production swaps
 * the adapter (Vault/KMS) without touching any call site.
 */
class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly rootDir: string) {}

  private refToPath(ref: string): string {
    // refs look like secret://integrations/<connectionId>/v1 — flatten
    // to a safe single filename (no traversal, no directory structure).
    const safe = ref.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 200);
    return join(this.rootDir, `${safe}.bin`);
  }

  async put(ref: string, plaintext: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", loadMasterKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([MAGIC, iv, tag, ct]);
    const path = this.refToPath(ref);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, blob);
  }

  async get(ref: string): Promise<string | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.refToPath(ref));
    } catch {
      return null;
    }
    if (blob.length < MAGIC.length + 12 + 16 || !blob.subarray(0, 4).equals(MAGIC)) return null;
    const iv = blob.subarray(4, 16);
    const tag = blob.subarray(16, 32);
    const ct = blob.subarray(32);
    try {
      const decipher = createDecipheriv("aes-256-gcm", loadMasterKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      return null; // tampered or wrong key — fail closed
    }
  }

  async delete(ref: string): Promise<void> {
    await unlink(this.refToPath(ref)).catch(() => undefined);
  }
}

function secretRoot(): string {
  return process.env.INTEGRATION_SECRET_DIR || "/home/z/my-project/.integration-secrets";
}

let defaultStore: SecretStore | null = null;
export function getSecretStore(): SecretStore {
  if (!defaultStore) defaultStore = new EncryptedFileSecretStore(secretRoot());
  return defaultStore;
}

/** Non-secret display fingerprint for rotation UX (never the secret). */
export function fingerprintSecret(plaintext: string): string {
  return createHmac("sha256", loadMasterKey()).update(plaintext).digest("hex").slice(0, 12).toUpperCase();
}

export interface StoredCredentialPayload {
  authType: string;
  apiKey?: string;
  webhookSecret?: string;
}

export interface SetCredentialResult {
  secretReference: string;
  keyFingerprint: string;
}

export const integrationCredentialService = {
  /**
   * Store/rotate credentials for a connection. Only the reference
   * and a display fingerprint are persisted to the DB.
   */
  async setCredentials(connectionRef: string, payload: StoredCredentialPayload): Promise<SetCredentialResult> {
    const existing = await db.integrationCredential.findUnique({ where: { connectionId: connectionRef } });
    const version = existing ? (existing.rotatedAt ? 2 : 1) : 1;
    const ref = `secret://integrations/${connectionRef}/v${version}`;
    const plaintext = JSON.stringify(payload);
    const store = getSecretStore();
    await store.put(ref, plaintext);
    const data = {
      secretReference: ref,
      keyFingerprint: fingerprintSecret(plaintext),
      rotatedAt: new Date(),
    };
    await db.integrationCredential.upsert({
      where: { connectionId: connectionRef },
      create: { connectionId: connectionRef, ...data },
      update: data,
    });
    return { secretReference: ref, keyFingerprint: data.keyFingerprint };
  },

  /** Resolve credentials for a provider call — memory only. */
  async resolve(connectionRef: string): Promise<StoredCredentialPayload | null> {
    const row = await db.integrationCredential.findUnique({ where: { connectionId: connectionRef } });
    if (!row) return null;
    const store = getSecretStore();
    const raw = await store.get(row.secretReference);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredCredentialPayload;
    } catch {
      return null;
    }
  },

  async remove(connectionRef: string): Promise<void> {
    const row = await db.integrationCredential.findUnique({ where: { connectionId: connectionRef } });
    if (!row) return;
    await getSecretStore().delete(row.secretReference);
    await db.integrationCredential.delete({ where: { connectionId: connectionRef } }).catch(() => undefined);
  },
};
