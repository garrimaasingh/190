import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_TTL_HOURS, AUTH_ALLOWED_STATUSES } from "@/lib/constants";
import { ApiError } from "@/lib/api";
import { permissionsForRole, type Permission, roleHas } from "@/lib/permissions";

// ============================================================
// Authentication & session core (spec §15/§16/§31).
// - Passwords: bcrypt (hash never leaves the server)
// - Token: signed JWT (HS256) containing ONLY the session id
// - Authority: the DB Session row (revocable, expirable)
// - Department is ALWAYS derived server-side from the
//   authenticated identity — never accepted from the client.
// - Clean abstraction point for future biometric auth
//   (Phase 10): verifyPassword()/issueSession() remain stable.
// ============================================================

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-only-insecure-secret-change-me"
);

export interface AuthContext {
  sessionId: string;
  officer: {
    id: string;
    officerId: string;
    name: string;
    email: string;
    phone: string | null;
    designation: string;
    role: string;
    status: string;
    departmentId: string;
    lastLoginAt: Date | null;
  };
  department: {
    id: string;
    departmentCode: string;
    name: string;
    departmentType: string;
    status: string;
    stateId: string;
    districtId: string;
    cityId: string;
  };
  permissions: Permission[];
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 11);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export async function issueSession(
  officerId: string,
  departmentId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null }
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);

  await db.session.create({
    data: {
      id: sessionId,
      officerId,
      departmentId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
    },
  });

  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(JWT_SECRET);

  return { sessionId, token, expiresAt };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

async function loadAuthContext(token: string | undefined): Promise<AuthContext> {
  if (!token) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
  }
  let sid: string;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    sid = String(payload.sid || "");
  } catch {
    throw new ApiError(401, "SESSION_EXPIRED", "Session is invalid or expired.");
  }
  if (!sid) throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");

  const session = await db.session.findUnique({ where: { id: sid } });
  if (!session) throw new ApiError(401, "SESSION_EXPIRED", "Session is invalid or expired.");
  if (session.revoked) throw new ApiError(401, "SESSION_REVOKED", "Session has been revoked.");
  if (session.expiresAt.getTime() < Date.now()) {
    throw new ApiError(401, "SESSION_EXPIRED", "Session is invalid or expired.");
  }

  const officer = await db.officer.findUnique({
    where: { id: session.officerId },
    include: { department: true },
  });
  if (!officer) throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
  if (!AUTH_ALLOWED_STATUSES.includes(officer.status)) {
    // Revoke the session of an officer who lost ACTIVE standing.
    await db.session.update({ where: { id: session.id }, data: { revoked: true, revokedAt: new Date() } });
    throw new ApiError(401, "ACCOUNT_INACTIVE", "Account is not permitted to authenticate.");
  }

  // Touch last activity (best-effort; sliding window bookkeeping)
  await db.session
    .update({ where: { id: session.id }, data: { lastActivity: new Date() } })
    .catch(() => undefined);

  return {
    sessionId: session.id,
    officer: {
      id: officer.id,
      officerId: officer.officerId,
      name: officer.name,
      email: officer.email,
      phone: officer.phone,
      designation: officer.designation,
      role: officer.role,
      status: officer.status,
      departmentId: officer.departmentId,
      lastLoginAt: officer.lastLoginAt,
    },
    department: {
      id: officer.department.id,
      departmentCode: officer.department.departmentCode,
      name: officer.department.name,
      departmentType: officer.department.departmentType,
      status: officer.department.status,
      stateId: officer.department.stateId,
      districtId: officer.department.districtId,
      cityId: officer.department.cityId,
    },
    permissions: permissionsForRole(officer.role),
  };
}

// FastAPI-style dependency: throws 401 unless a valid session exists.
export async function requireAuth(req: Request): Promise<AuthContext> {
  const token = getCookie(req, SESSION_COOKIE);
  return loadAuthContext(token);
}

// Requires authentication AND a specific permission.
export async function requirePermission(req: Request, permission: Permission): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (!roleHas(ctx.officer.role, permission)) {
    throw new ApiError(403, "FORBIDDEN", "You are not authorized to perform this action.");
  }
  return ctx;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.session
    .updateMany({ where: { id: sessionId, revoked: false }, data: { revoked: true, revokedAt: new Date() } })
    .catch(() => undefined);
}

export function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "127.0.0.1";
}
