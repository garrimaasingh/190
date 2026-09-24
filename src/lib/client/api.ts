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
