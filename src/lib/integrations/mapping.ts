import { db } from "@/lib/db";

// ============================================================
// Phase 8 — IntegrationMappingService (spec §18/§19/§20).
//
// Field mappings are DATA (versioned rows in IntegrationMappingVersion),
// never hard-coded inside providers. Responsibilities:
//   - field mapping (external path → central path)
//   - type conversion / normalization / defaults
//   - validation (required, max length, enum membership, formats)
//   - sensitive-field marking (forces human review, §15)
//
// An import records the schema + mapping version that processed it
// (§19). Unknown schema versions are NEVER silently processed — the
// import job rejects the record with SCHEMA_UNSUPPORTED (§69).
// ============================================================

export interface FieldMapping {
  /** External payload path, dot-separated (e.g. "investigatingOfficer.badge"). */
  from: string;
  /** Central target path within the mapped record (e.g. "officerBadge"). */
  to: string;
  type?: "string" | "number" | "boolean" | "date" | "enum";
  required?: boolean;
  default?: string | number | boolean | null;
  maxLen?: number;
  enumValues?: string[];
  /** Sensitive fields are NEVER auto-applied — they force review (§15). */
  sensitive?: boolean;
  /** Human-readable note surfaced in the review UI. */
  note?: string;
}

export interface MappingResult {
  values: Record<string, unknown>;
  missing: string[]; // required fields absent in the payload
  errors: Array<{ field: string; code: string; message: string }>;
  sensitiveFields: string[];
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function normalizeDate(input: unknown): Date | null {
  if (typeof input !== "string" && !(input instanceof Date)) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const integrationMappingService = {
  /** Load the active mapping set for a provider + record type. */
  async getActiveMapping(providerType: string, mappingName: string): Promise<{ mappingVersion: number; mappings: FieldMapping[] } | null> {
    const row = await db.integrationMappingVersion.findFirst({
      where: { providerType, mappingName, isActive: true },
      orderBy: { mappingVersion: "desc" },
    });
    if (!row) return null;
    try {
      return { mappingVersion: row.mappingVersion, mappings: JSON.parse(row.mappingJson) as FieldMapping[] };
    } catch {
      return null;
    }
  },

  /**
   * Map + validate one external payload into central-shape values.
   * A malformed record yields structured errors — it NEVER throws
   * (one bad record must not crash the import job, §20).
   */
  mapRecord(mappings: FieldMapping[], payload: Record<string, unknown>): MappingResult {
    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    const errors: MappingResult["errors"] = [];
    const sensitiveFields: string[] = [];

    for (const m of mappings) {
      const raw = readPath(payload, m.from);
      const absent = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");

      if (absent) {
        if (m.required) {
          missing.push(m.from);
          errors.push({ field: m.from, code: "REQUIRED_MISSING", message: `Required external field '${m.from}' is missing.` });
        } else if (m.default !== undefined) {
          values[m.to] = m.default;
        }
        continue;
      }

      switch (m.type) {
        case "number": {
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            errors.push({ field: m.from, code: "INVALID_TYPE", message: `Expected number, got '${String(raw).slice(0, 50)}'.` });
            continue;
          }
          values[m.to] = n;
          break;
        }
        case "boolean": {
          const b = raw === true || raw === "true" || raw === 1;
          if (!b && raw !== false && raw !== "false" && raw !== 0) {
            errors.push({ field: m.from, code: "INVALID_TYPE", message: `Expected boolean, got '${String(raw).slice(0, 50)}'.` });
            continue;
          }
          values[m.to] = b;
          break;
        }
        case "date": {
          const d = normalizeDate(raw);
          if (!d) {
            errors.push({ field: m.from, code: "INVALID_DATE", message: `Unparseable date '${String(raw).slice(0, 50)}'.` });
            continue;
          }
          values[m.to] = d;
          break;
        }
        case "enum": {
          const s = String(raw).trim().toUpperCase();
          if (!m.enumValues || !m.enumValues.includes(s)) {
            errors.push({
              field: m.from,
              code: "INVALID_ENUM",
              message: `Value '${s.slice(0, 50)}' not in allowed set (${(m.enumValues || []).slice(0, 6).join(", ")}…).`,
            });
            continue;
          }
          values[m.to] = s;
          break;
        }
        default: {
          let s = String(raw).trim();
          if (m.maxLen && s.length > m.maxLen) s = s.slice(0, m.maxLen);
          values[m.to] = s;
        }
      }

      if (m.sensitive) sensitiveFields.push(m.to);
    }

    return { values, missing, errors, sensitiveFields };
  },

  /**
   * Schema-version gate (§19/§69): payload version must be exactly a
   * registered, supported version for the provider — unknown versions
   * stop processing with a structured rejection, never a silent pass.
   */
  async isSchemaVersionSupported(providerType: string, schemaName: string, version: string): Promise<boolean> {
    const row = await db.integrationSchemaVersion.findUnique({
      where: { providerType_schemaName_schemaVersion: { providerType, schemaName, schemaVersion: version } },
    });
    return !!row && row.supported;
  },
};
