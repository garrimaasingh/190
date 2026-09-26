// Opaque storage keys for integration export packages — kept out of
// the export service to avoid circular imports with documents/storage.
import { randomUUID } from "crypto";

export function buildExportStorageKey(exportJobId: string): string {
  // Same opaque, non-guessable convention as document objects; exports
  // live under their own namespace inside the SAME storage root (§25:
  // no second storage architecture).
  return `exports/${exportJobId}/${randomUUID()}/object`;
}
