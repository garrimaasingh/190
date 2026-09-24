// ============================================================
// FileSecurityScanner (spec §45).
//
// ⚠️ DEVELOPMENT STUB — this is NOT malware protection.
//
// The production requirement is an integration with a trusted
// scanning system (ClamAV/icap/vendor appliance). Phase 3 ships a
// deterministic stub that detects a minimal, well-defined set of
// threat signatures (EICAR test string, Windows PE executables,
// PDFs launching embedded scripts) so the pipeline's quarantine
// and rejection paths are real and testable. It must be replaced
// by a real scanner before any production use — clearly labeled
// here and in the implementation report (no fake security).
// ============================================================

export type ScanVerdict = "SAFE" | "SUSPICIOUS" | "MALICIOUS" | "UNKNOWN";

export interface ScanResult {
  verdict: ScanVerdict;
  scanner: string;
  reason?: string;
}

const EICAR_PREFIX = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export function scanFileContent(buf: Buffer, mimeType: string): ScanResult {
  // Windows PE executable regardless of declared type (polyglot guard)
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5A) {
    return { verdict: "MALICIOUS", scanner: "dev-stub-v1", reason: "Executable signature (MZ) detected in document content." };
  }

  // EICAR antivirus test string — the canonical way to exercise AV pipelines
  if (buf.includes(Buffer.from(EICAR_PREFIX.slice(0, 40), "ascii"))) {
    return { verdict: "MALICIOUS", scanner: "dev-stub-v1", reason: "EICAR antivirus test signature detected." };
  }

  if (mimeType === "application/pdf") {
    const head = buf.subarray(0, Math.min(buf.length, 1024 * 1024)).toString("latin1");
    // Embedded script/launch constructs — treated as SUSPICIOUS (may be benign
    // in rare legitimate PDFs; a real scanner makes this call in production).
    if (/\/JavaScript|\/JS\b|\/Launch\b|\/OpenAction\s*<<|\/AA\s*<<|\/EmbeddedFile/.test(head)) {
      return { verdict: "SUSPICIOUS", scanner: "dev-stub-v1", reason: "PDF contains embedded script/launch constructs." };
    }
  }

  return { verdict: "SAFE", scanner: "dev-stub-v1" };
}
