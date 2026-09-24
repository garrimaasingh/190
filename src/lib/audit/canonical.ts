import { createHash } from "crypto";
import { AUDIT_GENESIS_SEED } from "@/lib/constants";

// ============================================================
// CanonicalAuditSerializer (spec §26/§55).
//
// ONE canonical serialization for EVERY audit event in the
// platform — no endpoint may serialize event data differently.
// A plain JSON.stringify is NOT acceptable: JavaScript object
// property order is insertion-ordered, so the same logical event
// could serialize two different ways and break the chain.
//
// Canonical form (deterministic by construction):
//   - FIXED field order (the order below, never derived from data)
//   - null / undefined  →  empty string
//   - booleans          →  "true" / "false"
//   - numbers           →  String(n)
//   - timestamp         →  Date.toISOString() (UTC, ms precision)
//   - metadata          →  recursively key-sorted JSON (arrays keep order)
//   - fields joined with "\n", every field prefixed "key="
//
// event_hash = SHA-256(canonical_payload) where the payload's final
// field is previous_event_hash (spec §25: H(event data + prev hash)).
// Recomputing the hash from stored fields reproduces the exact
// same string — verified byte-for-byte in the test suite.
// ============================================================

export const AUDIT_GENESIS_HASH = createHash("sha256").update(AUDIT_GENESIS_SEED).digest("hex");

/** Canonical JSON: object keys sorted recursively, stable separators. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isoOrNull(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** The exact event fields that participate in the hash — nothing else. */
export interface CanonicalAuditFields {
  eventId: string;
  sequence: number;
  eventType: string;
  actorOfficerId: string | null;
  actorDepartmentId: string | null;
  caseId: string | null;
  documentId: string | null;
  evidenceId: string | null;
  sessionId: string | null;
  timestamp: Date | string;
  result: string;
  metadata: string | null; // stored JSON string — re-canonicalized (sorted keys) before hashing
  previousEventHash: string;
}

export function canonicalAuditPayload(fields: CanonicalAuditFields): string {
  // Metadata: parse + re-serialize with sorted keys so the hash does
  // not depend on the key order that happened to be persisted.
  let metadataCanonical = "";
  if (fields.metadata) {
    try {
      metadataCanonical = canonicalJson(JSON.parse(fields.metadata));
    } catch {
      metadataCanonical = fields.metadata; // non-JSON metadata is hashed verbatim
    }
  }
  return [
    `event_id=${fields.eventId}`,
    `sequence=${fields.sequence}`,
    `event_type=${fields.eventType}`,
    `actor_officer_id=${fields.actorOfficerId ?? ""}`,
    `actor_department_id=${fields.actorDepartmentId ?? ""}`,
    `case_id=${fields.caseId ?? ""}`,
    `document_id=${fields.documentId ?? ""}`,
    `evidence_id=${fields.evidenceId ?? ""}`,
    `session_id=${fields.sessionId ?? ""}`,
    `timestamp=${isoOrNull(fields.timestamp)}`,
    `result=${fields.result}`,
    `metadata=${metadataCanonical}`,
    `previous_event_hash=${fields.previousEventHash}`,
  ].join("\n");
}

export function hashAuditEvent(fields: CanonicalAuditFields): string {
  return createHash("sha256").update(canonicalAuditPayload(fields)).digest("hex");
}

/** Sanity helper used by tests: the genesis hash is reproducible. */
export function describeGenesis(): { seed: string; hash: string; algorithm: string } {
  return { seed: AUDIT_GENESIS_SEED, hash: AUDIT_GENESIS_HASH, algorithm: "SHA-256" };
}
