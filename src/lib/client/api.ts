"use client";

// ============================================================
// Typed API client — single fetch wrapper for the /api/v1
// surface. Cookies are httpOnly so the token is never readable
// by client JS (XSS-safe by construction).
// ============================================================

export class ApiClientError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Transient failures (e.g. a dev-server restart mid-request, proxy hiccup)
// surface as network errors or 5xx. Idempotent GETs are safe to retry once
// after a short backoff so a cold-start race never bricks the UI.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(path: string, init?: RequestInit): Promise<Response> {
  const isGet = (init?.method ?? "GET") === "GET";
  try {
    const res = await fetch(path, init);
    if (isGet && RETRYABLE_STATUS.has(res.status)) {
      await sleep(350);
      return fetch(path, init);
    }
    return res;
  } catch (err) {
    if (isGet) {
      await sleep(350);
      try {
        return await fetch(path, init);
      } catch {
        throw err; // surface the original network error
      }
    }
    throw err;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRetry(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init?.headers || {}),
    },
    credentials: "same-origin",
  });

  let body: { data?: T; error?: { code: string; message: string } } | null = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/v1/auth/")) {
      // Session expired mid-use — reload once so the app router resolves to
      // the login view instead of stacking errors on a stale view.
      window.location.assign("/");
      throw new ApiClientError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
    }
    throw new ApiClientError(
      res.status,
      body?.error?.code || "REQUEST_FAILED",
      body?.error?.message || `Request failed (${res.status}).`
    );
  }
  return body?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---------- Phase 3: secure document streaming helpers ----------
// Content is fetched through the authorized API (cookie-authenticated)
// and materialized client-side; raw storage URLs never exist (spec §31).

/** Fetches a document as a Blob for inline preview (PDF/image/text). */
export async function fetchDocumentBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      // non-JSON
    }
    throw new ApiClientError(res.status, "STREAM_FAILED", message);
  }
  return res.blob();
}

/** Authoritative download: streams through the API and triggers a save dialog. */
export async function downloadDocument(path: string, filename: string): Promise<void> {
  const blob = await fetchDocumentBlob(path);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// ---------- shared types ----------
export interface Me {
  officer: {
    id: string;
    officerId: string;
    name: string;
    email: string;
    phone: string | null;
    designation: string;
    role: string;
    status: string;
    lastLoginAt: string | null;
  };
  department: {
    id: string;
    departmentCode: string;
    name: string;
    departmentType: string;
    description: string | null;
    status: string;
    logoPath: string | null;
    createdAt: string;
    geography: { country: string; state: string; district: string; city: string } | null;
  } | null;
  permissions: string[];
  session: { sessionId: string };
}

export interface Meta {
  departmentTypes: string[];
  departmentStatuses: string[];
  officerRoles: string[];
  officerStatuses: string[];
  officerStatusTransitions: Record<string, string[]>;
  rolePermissions: Record<string, string[]>;
  // Phase 2
  caseTypes: string[];
  casePriorities: string[];
  caseStatuses: string[];
  caseStatusTransitions: Record<string, string[]>;
  participationTypes: string[];
  caseOfficerRoles: string[];
  caseOfficerStatuses: string[];
  transferStatuses: string[];
  caseEventTypes: string[];
  // Phase 3
  documentTypes: string[];
  documentCategories: string[];
  documentClassifications: string[];
  documentClassificationNotes: Record<string, string>;
  documentClassificationCeiling: Record<string, number>;
  documentStatuses: string[];
  documentRelationshipTypes: string[];
  documentEventTypes: string[];
  documents: { maxSizeMb: number; allowedExtensions: string[] };
}

export interface DepartmentListItem {
  id: string;
  departmentCode: string;
  name: string;
  departmentType: string;
  description: string | null;
  logoPath: string | null;
  status: string;
  createdAt: string;
  location: { city: string | null; district: string | null; state: string | null };
  officerCount: number;
}

export interface DepartmentDetail {
  id: string;
  departmentCode: string;
  name: string;
  departmentType: string;
  description: string | null;
  logoPath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  geography: { country: string; state: string; district: string; city: string };
  officerCount: number;
  administrators: { id: string; officerId: string; name: string; role: string; status: string }[];
}

export interface OfficerRow {
  id: string;
  officerId: string;
  name: string;
  email?: string;
  phone?: string | null;
  designation: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt?: string;
  department?: { id: string; name: string; departmentType: string };
  departmentId?: string;
}

export interface AdminStats {
  geography: { countries: number; states: number; districts: number; cities: number };
  departments: { total: number; active: number; inactive: number; pending: number };
  officers: { total: number; active: number };
}

export interface IdentityEventRow {
  id: string;
  eventType: string;
  actorOfficerId: string | null;
  actorIdentifier: string | null;
  departmentId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CountryRow { id: string; name: string; code: string }
export interface StateRow { id: string; name: string; code: string; status: string; countryId: string }
export interface DistrictRow { id: string; name: string; code: string; status: string; stateId: string }
export interface CityRow { id: string; name: string; code: string; status: string; districtId: string }

export function logoUrl(logoPath: string | null | undefined): string | null {
  return logoPath ? `/api/v1/files/logos/${logoPath}` : null;
}

// ============================================================
// PHASE 2 — case types
// ============================================================

export interface CaseRow {
  id: string;
  caseId: string;
  caseNumber: string | null;
  title: string;
  caseType: string;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  originatingDepartment: { id: string; name: string; departmentType: string };
  currentCustodianDepartment: { id: string; name: string; departmentType: string };
  district: { name: string };
  city: { name: string };
}

export interface DepartmentRef {
  id: string;
  departmentCode: string;
  name: string;
  departmentType: string;
  logoPath?: string | null;
}

export interface OfficerRef {
  id: string;
  officerId: string;
  name: string;
  designation: string;
  role: string;
  status: string;
}

export interface CaseParticipant {
  id: string;
  department: DepartmentRef;
  participationType: string;
  status?: string;
  isOrigin: boolean;
  isCustodian: boolean;
  joinedAt: string;
}

export interface CaseOfficerRow {
  id: string;
  officer: OfficerRef;
  department: { id: string; name: string; departmentType: string };
  roleOnCase: string;
  status: string;
  assignedAt: string;
  unassignedAt: string | null;
}

export interface CaseTransferRow {
  id: string;
  transferId: string;
  status: string;
  reason: string;
  transferNotes?: string | null;
  fromDepartment: { id: string; name: string };
  toDepartment: { id: string; name: string };
  requestedByOfficer: { officerId: string; name: string };
  acceptedByOfficer?: { officerId: string; name: string } | null;
  toOfficer?: { officerId: string; name: string } | null;
  requestedAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
}

export interface CaseTimelineEvent {
  id: string;
  eventType: string;
  actor: { id: string; officerId: string; name: string } | null;
  actorIdentifier: string | null;
  department: string | null;
  description: string | null;
  createdAt: string;
}

export interface CaseViewerAccess {
  level: "none" | "view" | "manage";
  view: boolean;
  manage: boolean;
  isCustodianSide: boolean;
  isOriginSide: boolean;
  assigned: boolean;
  reasons: string[];
}

export interface CaseDetail {
  id: string;
  caseId: string;
  caseNumber: string | null;
  title: string;
  description: string | null;
  caseType: string;
  caseCategory: string | null;
  priority: string;
  status: string;
  mutable: boolean;
  allowedTransitions: string[];
  geography: { state: string; district: string; city: string };
  originatingDepartment: DepartmentRef;
  currentCustodianDepartment: DepartmentRef;
  currentCustodianOfficer: { id: string; officerId: string; name: string; designation: string } | null;
  createdByOfficer: { id: string; officerId: string; name: string };
  openedAt: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  participants: CaseParticipant[];
  officers: CaseOfficerRow[];
  transfers: CaseTransferRow[];
  timeline: CaseTimelineEvent[];
  viewer: CaseViewerAccess;
}

export interface IncomingTransferRow {
  id: string;
  transferId: string;
  status: string;
  reason: string;
  requestedAt: string;
  case: { caseId: string; title: string; status: string; priority: string; caseType: string };
  fromDepartment: { id: string; name: string; departmentType: string };
  requestedByOfficer: { officerId: string; name: string };
}

// ============================================================
// PHASE 3 — document types
// ============================================================

export interface DocumentMetadata {
  referenceNumber?: string;
  issuingDepartmentName?: string;
  externalReference?: string;
  tags?: string[];
}

export interface DocumentRow {
  id: string; // public document id (DOC-…)
  caseId: string;
  title: string;
  description: string | null;
  documentType: string;
  documentCategory: string | null;
  classification: string;
  status: string;
  originalFilename: string;
  mimeType: string;
  fileExtension: string;
  fileSize: number;
  sha256Hash: string;
  encryptionStatus: string;
  documentDate: string | null;
  uploadedAt: string;
  committedAt: string | null;
  supersededByDocumentId: string | null;
  uploadedBy: { officerId: string; name: string } | null;
  department: { id: string; name: string; departmentType: string } | null;
  metadata: DocumentMetadata | null;
}

export interface DocumentListResponse {
  items: DocumentRow[];
  total: number;
  page: number;
  pageSize: number;
  caseId: string;
  canUpload: boolean;
}

export interface DocumentUploadResponse {
  quarantined: boolean;
  replayed?: boolean;
  duplicateWarning: string | null;
  document: DocumentRow;
  message?: string;
}

export interface RelatedDocumentResponse {
  quarantined: boolean;
  duplicateWarning: string | null;
  supersededTarget: boolean;
  relationshipType: string;
  document: DocumentRow;
}

export interface DocumentRelationshipEntry {
  id: string;
  relationshipType: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
  document: {
    documentId: string;
    title: string;
    classification: string;
    status: string;
    documentType: string;
  };
  counterpart?: never;
}

export interface DocumentRelationshipsResponse {
  documentId: string;
  relationships: DocumentRelationshipEntry[];
}

export interface DocumentDetailResponse {
  document: DocumentRow;
  case: { caseId: string; status: string };
  relationships: {
    outgoing: DocumentRelationshipEntry[];
    incoming: DocumentRelationshipEntry[];
  };
}

export interface DocumentEventEntry {
  id: string;
  eventType: string;
  result: string | null;
  actor: { officerId: string; name: string } | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface DocumentEventsResponse {
  documentId: string;
  caseId: string;
  events: DocumentEventEntry[];
}

export interface IntegrityVerifyResponse {
  documentId: string;
  match: boolean;
  recordedHash: string;
  computedHash: string;
}

// ---------- Phase 4: evidence & audit types ----------

export interface EvidenceRow {
  id: string;
  caseId: string;
  evidenceNumber: string | null;
  title: string;
  description: string | null;
  evidenceType: string;
  category: string | null;
  status: string;
  classification: string;
  sourceType: string;
  sourceReference: string | null;
  collectionLocation: string | null;
  collectedAt: string | null;
  receivedAt: string | null;
  condition: string | null;
  notes: string | null;
  deviceMetadata: Record<string, string> | null;
  hasDigitalContent: boolean;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  sha256Hash: string | null;
  hashAlgorithm: string;
  encryptionStatus: string | null;
  registeredByOfficer: { officerId: string; name: string } | null;
  currentCustodianDepartment: { id: string; departmentCode: string; name: string; departmentType: string } | null;
  currentCustodianOfficer: { officerId: string; name: string } | null;
  collectedByOfficer: { officerId: string; name: string } | null;
  collectingDepartment: { id: string; departmentCode: string; name: string; departmentType: string } | null;
  committedAt: string | null;
  createdAt: string;
}

export interface EvidenceListResponse {
  items: EvidenceRow[];
  total: number;
  page: number;
  pageSize: number;
  caseId: string;
  canRegister: boolean;
}

export interface EvidenceRelationshipRow {
  id: string;
  relationshipType: string;
  note: string | null;
  createdAt: string;
  document: { documentId: string; title: string; documentType: string; classification: string; status: string };
  createdByOfficer: { officerId: string; name: string } | null;
}

export interface CustodyChainEntry {
  kind: "COLLECTED" | "TRANSFER";
  timestamp: string;
  actorDepartment: string | null;
  actorOfficer: string | null;
  action: string;
  status: string;
  fromDepartment: string | null;
  toDepartment: string | null;
  detail: Record<string, unknown> | null;
}

export interface CustodyChainResponse {
  evidenceId: string;
  currentCustodian: { department: string; officer: string | null } | null;
  status: string;
  chain: CustodyChainEntry[];
}

export interface AuditEventRow {
  eventId: string;
  sequence: number;
  eventType: string;
  actor: { officerId: string; name: string } | null;
  actorIdentifier: string | null;
  actorDepartmentId: string | null;
  caseId: string | null;
  documentId: string | null;
  evidenceId: string | null;
  sessionId: string | null;
  timestamp: string;
  result: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  previousEventHash: string;
  eventHash: string;
  ledgerStatus: string;
}

export interface AuditListResponse {
  items: AuditEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditIntegrityStatus {
  chain: {
    eventCount: number;
    lastSequence: number;
    lastEventHash: string;
    lastEventId: string | null;
    genesisHash: string;
    hashAlgorithm: string;
  };
  lastVerification: {
    verifiedAt: string;
    result: string;
    verifiedThroughSequence: number | null;
    firstInvalidSequence: number | null;
  } | null;
  ledgerAdapters: { name: string; live: boolean }[];
}

export interface ChainVerificationResponse {
  valid: boolean;
  algorithm: string;
  eventsChecked: number;
  fromSequence: number;
  toSequence: number;
  headHash: string | null;
  firstInvalid: {
    sequence: number;
    eventId: string;
    reason: string;
    expectedHash?: string;
    actualHash?: string;
    expectedPreviousHash?: string;
  } | null;
}

export interface LedgerAnchorRow {
  anchorId: string;
  provider: string;
  chainHash: string;
  upToSequence: number;
  eventCount: number;
  externalReference: string | null;
  anchoredAt: string;
}

export interface CaseIntegritySummary {
  caseId: string;
  documents: number;
  evidence: number;
  custodyTransfers: number;
  auditEvents: number | null;
  auditEventsNote?: string;
  chain: {
    valid: boolean;
    algorithm: string;
    eventCount: number;
    lastEventHash: string;
    lastVerifiedAt: string | null;
    informationalOnly: boolean;
  };
}

// ============================================================
// Phase 6 — Case knowledge graph (spec §67).
// ============================================================

export interface GraphNodePayload {
  id: string;
  nodeKey: string;
  nodeType: "CASE" | "DOCUMENT" | "EVIDENCE" | "ENTITY" | "DEPARTMENT";
  label: string;
  refId: string | null;
  entityType: string | null;
  classification: string | null;
  status: string | null;
  provenance: { model: string; id: string }[];
}

export interface GraphEdgePayload {
  id: string;
  edgeKey: string;
  sourceKey: string;
  targetKey: string;
  edgeType: "CONTAINS" | "RELATIONSHIP" | "MENTIONS" | "SAME_ENTITY" | "PARTICIPATION";
  relationshipType: string | null;
  provenance: string;
  sourceRefs: { model: string; id: string }[];
  confirmedByOfficerId: string | null;
  confidence: number | null;
}

export interface CaseGraphPayload {
  caseRef: string;
  graph: { nodes: GraphNodePayload[]; edges: GraphEdgePayload[] };
  sync: {
    status: string;
    nodeCount: number;
    edgeCount: number;
    syncVersion: number;
    lastSyncedAt: string | null;
    triggeredByOfficerId: string | null;
  } | null;
  staleness: {
    neverSynced: boolean;
    stale: boolean;
    newestSourceAt: string | null;
    lastSyncedAt: string | null;
  };
  viewer: {
    clearanceLevel: number;
    level: string;
    droppedNodes: number;
    droppedEdges: number;
    visibleNodes: number;
    visibleEdges: number;
  };
  disclaimer: string;
}

// ---------- Phase 9: manual interoperability (import/export packages) ----------

export interface InteropExportPreview {
  caseId: string;
  title: string;
  documents: { documentId: string; title: string; documentType: string; classification: string; status: string; fileSize: number; mimeType: string; committedAt: string | null; selectable: boolean }[];
  evidence: { evidenceId: string; title: string; evidenceType: string; classification: string; status: string; hasBinary: boolean; selectable: boolean }[];
  relationships: { id: string; sourceDocumentId: string; targetDocumentId: string; relationshipType: string; selectable: boolean }[];
  auditEventsAvailable: boolean;
  interopNote: string;
}

export interface InteropExportJob {
  jobId: string;
  packageId: string | null;
  exportType: string;
  status: string;
  classification: string | null;
  recordCounts: { cases: number; documents: number; evidence: number; relationships: number; auditEvents: number; excluded: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string | null;
  packageSize: number | null;
  packageSha256: string | null;
  requestedBy: { officerId: string; name: string };
}

export interface InteropImportJobRow {
  jobId: string;
  packageId: string | null;
  status: string;
  stage: string | null;
  packageType: string | null;
  schemaVersion: string | null;
  sourceSystem: string | null;
  packageTypeClassification: string | null;
  integrityResult: string | null;
  signatureStatus: string | null;
  scanStatus: string | null;
  recordsReceived: number;
  recordsValid: number;
  recordsInvalid: number;
  recordsConflicted: number;
  recordsImported: number;
  requiresApproval: boolean;
  errorSummary: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  uploadedByOfficer?: { officerId: string; name: string };
}

export interface InteropConflict {
  conflictId: string;
  importJobId: string;
  recordType: string;
  recordRecordId: string | null;
  fieldName: string;
  centralValue: string | null;
  incomingValue: string | null;
  sourceReference: string | null;
  conflictType: string;
  status: string;
  resolvedByOfficerId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface InteropImportRecord {
  id: string;
  importJobId: string;
  recordType: string;
  externalId: string;
  resolution: string | null;
  targetEntityId: string | null;
  payloadJson: string | null;
  payloadPath: string | null;
  binarySha256: string | null;
  validationStatus: string;
  conflictStatus: string;
  authorizationStatus: string;
  processingStatus: string;
  errorDetails: string | null;
}

export interface InteropPackageInfo {
  packageId: string;
  packageType: string;
  schemaVersion: string;
  sourceSystem: string;
  sourceDepartment: string | null;
  createdInEnvironment: string | null;
  classification: string;
  caseCount: number;
  documentCount: number;
  evidenceCount: number;
  relationshipCount: number;
  packageIntegrity: string;
  packageSha256: string;
  manifestHash: string;
  signature: { algorithm: string; status: string; note: string | null } | null;
  integrityChecks: { kind: string; result: string; verifiedAt: string }[];
  fileCount?: number;
  downloadCount?: number;
  createdAt: string;
}

export interface InteropImportJobDetail {
  job: InteropImportJobRow & { uploadedByDepartmentId: string };
  records: InteropImportRecord[];
  approvals: { id: string; decision: string; comment: string | null; createdAt: string; reviewerOfficer: { officerId: string; name: string } }[];
  conflicts: InteropConflict[];
  package: InteropPackageInfo | null;
  interopNote: string;
}

export interface InteropCommitResult {
  job: InteropImportJobRow;
  counters: { received: number; imported: number; rejected: number; conflicted: number; skipped: number };
  graphSync: { caseRef: string; ok: boolean; error?: string }[];
  interopNote: string;
}
