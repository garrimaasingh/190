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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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
