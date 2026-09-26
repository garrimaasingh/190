import type {
  IntegrationCapabilityKey,
  IntegrationEnvironment,
  IntegrationErrorCategory,
} from "@/lib/constants";
import { INTEGRATION_CAPABILITY_KEYS as INTEGRATION_CAPABILITY_KEYS_LIST } from "@/lib/constants";

// ============================================================
// Phase 8 — IntegrationProvider abstraction (spec §3/§4).
//
// The core application NEVER contains provider-specific logic:
// providers declare their capabilities and implement only the
// operations they actually support (optional methods — unsupported
// operations are simply absent, never stubbed to lie, spec §3).
//
// HONESTY RULE (spec §1/§71): no real government API is invented.
// Every provider shipped in this phase is a MOCK that simulates an
// external system. A future REAL provider implements the same
// interface against a verified, documented government interface.
// ============================================================

export interface IntegrationCapabilities {
  can_search_cases: boolean;
  can_read_case: boolean;
  can_import_case: boolean;
  can_export_case: boolean;
  can_read_documents: boolean;
  can_import_documents: boolean;
  can_export_documents: boolean;
  can_read_evidence: boolean;
  can_import_evidence: boolean;
  can_export_evidence: boolean;
  supports_webhooks: boolean;
  supports_polling: boolean;
  supports_batch_import: boolean;
  supports_realtime: boolean;
  supports_acknowledgement: boolean;
}

export function emptyCapabilities(): IntegrationCapabilities {
  return {
    can_search_cases: false,
    can_read_case: false,
    can_import_case: false,
    can_export_case: false,
    can_read_documents: false,
    can_import_documents: false,
    can_export_documents: false,
    can_read_evidence: false,
    can_import_evidence: false,
    can_export_evidence: false,
    supports_webhooks: false,
    supports_polling: false,
    supports_batch_import: false,
    supports_realtime: false,
    supports_acknowledgement: false,
  };
}

/** Validate an arbitrary capability object against the registry (no unknown keys). */
export function assertCapabilityKeys(keys: Record<string, unknown>): void {
  for (const key of Object.keys(keys)) {
    if (!(INTEGRATION_CAPABILITY_KEYS_LIST as readonly string[]).includes(key)) {
      throw new Error(`UNKNOWN_CAPABILITY:${key}`);
    }
  }
}

/** Non-secret runtime config carried with the connection row. */
export interface ProviderRuntimeConfig {
  timeoutMs: number; // bounded timeouts (spec §68)
  maxRetries: number;
  baseBackoffMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  // MOCK-only simulation switches (never meaningful for REAL providers):
  latencyMs?: number;
  failNext?: number; // fail the next N provider calls with SERVER_ERROR
  rateLimitPerMinute?: number;
  scenarioSchemaVersion?: string; // force a payload schema version
  corruptDocumentHashFor?: string; // §55 simulation: external system reports a wrong hash for this document id
}

export const DEFAULT_PROVIDER_CONFIG: ProviderRuntimeConfig = {
  timeoutMs: 10_000,
  maxRetries: 3,
  baseBackoffMs: 200,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 30_000,
};

/** Resolved credential — lives in memory only, never logged/persisted. */
export interface ResolvedCredential {
  authType: string;
  apiKey?: string;
  webhookSecret?: string;
  [key: string]: unknown;
}

/** Per-call context handed to every provider operation. */
export interface ProviderCallContext {
  connectionId: string;
  connectionRef: string; // public connectionId
  providerType: string;
  providerMode: string; // MOCK | SANDBOX | REAL
  environment: IntegrationEnvironment | string;
  config: ProviderRuntimeConfig;
  credential: ResolvedCredential | null;
  /** Correlation id for call logs / audit (never content). */
  callId: string;
}

// ------------------------------------------------------------
// Result types — payloads are normalized EXTERNAL shapes; mapping
// into central shapes happens in the mapping layer, not here.
// ------------------------------------------------------------

export interface ExternalCaseSummary {
  externalCaseId: string;
  externalCaseNumber?: string | null;
  title: string;
  caseType?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  schemaVersion: string;
}

export interface ExternalCasePayload extends ExternalCaseSummary {
  description?: string | null;
  priority?: string | null;
  district?: string | null;
  state?: string | null;
  investigatingOfficer?: { name?: string | null; badge?: string | null } | null;
  caseNumber?: string | null;
  documents: ExternalDocumentPayload[];
  evidence: ExternalEvidencePayload[];
}

export interface ExternalDocumentPayload {
  externalDocumentId: string;
  title: string;
  documentType?: string | null;
  classification?: string | null;
  documentDate?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  /** base64 content — fetched only when explicitly requested (data minimization §64) */
  contentBase64?: string | null;
  /** SHA-256 the external system claims over the bytes (verified at import, §26) */
  sourceHash?: string | null;
  sizeBytes?: number | null;
}

export interface ExternalEvidencePayload {
  externalEvidenceId: string;
  title: string;
  description?: string | null;
  evidenceType?: string | null;
  classification?: string | null;
  sourceCustodian?: string | null;
  sourceDepartment?: string | null;
  collectionLocation?: string | null;
  collectedAt?: string | null;
  /** false/absent → the platform records HISTORY_UNAVAILABLE, never invents custody (§27) */
  custodyTrail?: { available: boolean; events?: Array<{ action: string; actor?: string | null; at?: string | null }> } | null;
  currentExternalHolder?: string | null;
}

export interface ExternalCaseSearchQuery {
  q?: string;
  updatedSince?: string; // ISO cursor (§34)
  page?: number;
  pageSize?: number;
}

export interface ProviderAck {
  accepted: boolean;
  externalReference?: string | null;
  acknowledgedAt: string;
  message?: string | null;
}

export interface ProviderHealthResult {
  ok: boolean;
  latencyMs: number;
  detail?: string | null;
  errorCategory?: IntegrationErrorCategory | null;
}

export interface ProviderAuthResult {
  ok: boolean;
  errorCategory?: IntegrationErrorCategory | null;
  detail?: string | null;
}

export interface WebhookVerificationInput {
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookVerificationResult {
  verified: boolean;
  signatureStatus: "VERIFIED" | "INVALID" | "MISSING" | "DISABLED";
  errorCategory?: IntegrationErrorCategory | null;
  detail?: string | null;
}

export interface ParsedWebhookEvent {
  externalEventId?: string | null;
  eventType: string;
  occurredAt?: string | null;
  schemaVersion?: string | null;
  payload: Record<string, unknown>;
}

// ------------------------------------------------------------
// The provider interface (spec §3). Operations a provider does not
// support are left UNDEFINED — the capability model is the source
// of truth for what may be called.
// ------------------------------------------------------------

export interface IntegrationProvider {
  readonly providerType: string;
  readonly providerMode: "MOCK" | "SANDBOX" | "REAL";
  readonly schemaName: string;
  readonly supportedSchemaVersions: string[];
  readonly capabilities: IntegrationCapabilities;
  /** Lower bound the provider allows for polling (spec §33). */
  readonly minPollingIntervalMinutes: number;

  connect(ctx: ProviderCallContext): Promise<ProviderHealthResult>;
  authenticate(ctx: ProviderCallContext): Promise<ProviderAuthResult>;
  healthCheck(ctx: ProviderCallContext): Promise<ProviderHealthResult>;
  disconnect(ctx: ProviderCallContext): Promise<void>;

  // Optional, capability-gated operations:
  searchCases?(ctx: ProviderCallContext, query: ExternalCaseSearchQuery): Promise<{ items: ExternalCaseSummary[]; total: number; nextCursor?: string | null }>;
  getCase?(ctx: ProviderCallContext, externalCaseId: string): Promise<ExternalCasePayload>;
  getDocumentContent?(ctx: ProviderCallContext, externalCaseId: string, externalDocumentId: string): Promise<ExternalDocumentPayload>;
  getEvidence?(ctx: ProviderCallContext, externalCaseId: string): Promise<ExternalEvidencePayload[]>;
  exportCase?(ctx: ProviderCallContext, pkg: ExportCasePackage): Promise<ProviderAck>;
  verifyWebhookSignature?(ctx: ProviderCallContext, input: WebhookVerificationInput): Promise<WebhookVerificationResult>;
  parseWebhookEvent?(ctx: ProviderCallContext, input: WebhookVerificationInput): Promise<ParsedWebhookEvent | null>;
}

/** Structured provider error — classified for retry policy (§67). */
export class ProviderError extends Error {
  category: IntegrationErrorCategory;
  retryAfterSeconds?: number;
  httpStatus?: number;
  constructor(category: IntegrationErrorCategory, message: string, opts?: { retryAfterSeconds?: number; httpStatus?: number }) {
    super(message);
    this.name = "ProviderError";
    this.category = category;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    this.httpStatus = opts?.httpStatus;
  }
}

// ------------------------------------------------------------
// Export package (spec §44/§45): the structured, provider-agnostic
// exchange bundle. Document BYTES are optional and only included
// when the export explicitly requests them AND the actor is
// authorized — metadata-only by default (data minimization §64).
// ------------------------------------------------------------

export interface ExportManifestEntry {
  documentId: string; // public DOC-…
  filename: string;
  sha256: string;
  size: number;
  mimeType: string;
  exportedAt: string;
  exportJobId: string;
}

export interface ExportCasePackage {
  packageVersion: string;
  exportJobId: string;
  exportedAt: string;
  exportedByOfficerId: string;
  case: {
    caseId: string;
    caseNumber?: string | null;
    title: string;
    description?: string | null;
    caseType: string;
    status: string;
    priority: string;
  };
  documents: Array<{
    documentId: string;
    title: string;
    documentType: string;
    classification: string;
    status: string;
    sha256: string;
    size: number;
    mimeType: string;
    filename: string;
    contentBase64?: string | null;
  }>;
  evidence: Array<{
    evidenceId: string;
    title: string;
    evidenceType: string;
    classification: string;
    status: string;
    hasDigitalContent: boolean;
    sha256?: string | null;
  }>;
  relationships: Array<{ source: string; target: string; type: string }>;
  integrity: {
    manifestVersion: string;
    algorithm: "SHA-256";
    entries: ExportManifestEntry[];
  };
}
