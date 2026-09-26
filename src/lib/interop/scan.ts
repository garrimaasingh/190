import { scanFileContent, type ScanVerdict } from "@/lib/documents/scanner";

// ============================================================
// Phase 9 — security scan gate for packaged binaries (§28/§76).
//
// Delegates to the Phase 3 FileSecurityScanner — which is an
// honestly-labeled DEVELOPMENT STUB (magic-byte + signature heuristics:
// MZ executables, EICAR, embedded PDF scripts). It is NOT production
// malware protection; a real scanner is a production requirement and
// this is the seam where one plugs in. The verdict mapping below
// keeps "MALICIOUS" blocking and "SUSPICIOUS" visible in the UI.
// ============================================================

export interface BinaryScanResult {
  verdict: ScanVerdict;
  scanner: string;
  reason: string;
}

export function scanBuffer(buf: Buffer, originalFilename: string, declaredMimeType: string): ScanVerdict {
  void originalFilename; // §76: decisions are NEVER based on the filename alone
  const result = scanFileContent(buf, declaredMimeType || "application/octet-stream");
  return result.verdict;
}
