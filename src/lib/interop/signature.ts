// ============================================================
// Phase 9 — pluggable package signature service (§15).
//
// DESIGN ONLY + HONEST DEFAULT: no signing algorithm is active in
// this implementation. A hash (SHA-256) proves that package bytes
// are unmodified — it does NOT prove WHO created the package.
// That distinction is surfaced everywhere a package is displayed.
//
// Future implementations must use a standard algorithm (RSA /
// ECDSA / Ed25519 via a maintained crypto library) and a real
// key-management story. Custom cryptography is forbidden (§15).
// ============================================================

export interface PackageSignatureResult {
  /** Machine-readable status stored on the package. */
  status: "UNSIGNED" | "UNSUPPORTED" | "VALID" | "INVALID";
  algorithm: string;
  /** Display note — never claim a hash is a signature. */
  note: string;
  signaturePayload?: string;
}

export interface PackageSignatureService {
  readonly name: string;
  readonly available: boolean;
  sign(packageBytes: Buffer, context: { packageId: string; signerOfficerId: string }): Promise<PackageSignatureResult>;
  verify(packageBytes: Buffer, signature: { algorithm: string; signaturePayload: string }): Promise<PackageSignatureResult>;
}

/**
 * Default no-op service: reports honestly that signatures are not
 * configured. sign() returns UNSIGNED so packages remain usable
 * under SHA-256 integrity verification alone (§15).
 */
export class UnsupportedSignatureService implements PackageSignatureService {
  readonly name = "unsupported-signature";
  readonly available = false;

  async sign(): Promise<PackageSignatureResult> {
    return {
      status: "UNSIGNED",
      algorithm: "UNSUPPORTED",
      note: "Digital signatures are not configured in this deployment. Package authenticity relies on the SHA-256 integrity manifest plus the authorized transfer channel — a matching hash proves the package is unmodified, NOT who created it.",
    };
  }

  async verify(): Promise<PackageSignatureResult> {
    return {
      status: "UNSUPPORTED",
      algorithm: "UNSUPPORTED",
      note: "No signature verification service is configured; signature status is UNSUPPORTED (not VALID).",
    };
  }
}

export const packageSignatureService: PackageSignatureService = new UnsupportedSignatureService();
