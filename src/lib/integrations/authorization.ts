import type { AuthContext } from "@/lib/auth";
import { roleHas, type Permission } from "@/lib/permissions";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit/service";
import type { IntegrationConnection } from "@prisma/client";

// ============================================================
// Phase 8 — Integration authorization (spec §38/§39).
//
// Role permission (permissions.ts) is necessary but NOT sufficient:
//   1. DEPARTMENT SCOPING — a connection owned by Department A is
//      not usable by Department B unless the actor is SYSTEM_ADMIN
//      (platform-level) or the connection is GLOBAL. AUDITOR is
//      read-only platform-wide, consistent with audit visibility.
//   2. PER-CONNECTION operation gate — allowedOperations csv.
//   3. CASE-LEVEL access — import/export targets additionally go
//      through the existing case access model at the service layer.
// Denials are audited (INTEGRATION_ACCESS_DENIED) with generic
// responses — no information leak.
// ============================================================

export function assertIntegrationPermission(ctx: AuthContext, permission: Permission): void {
  if (!roleHas(ctx.officer.role, permission)) {
    throw new ApiError(403, "FORBIDDEN", "You are not authorized to perform this action.");
  }
}

export function isSystemAdmin(ctx: AuthContext): boolean {
  return ctx.officer.role === "SYSTEM_ADMIN";
}

/** Department-scoped visibility for LIST endpoints. */
export function connectionVisibleTo(ctx: AuthContext, connection: { ownerDepartmentId: string; scope: string }): boolean {
  if (isSystemAdmin(ctx)) return true;
  if (ctx.officer.role === "AUDITOR") return true; // read-only platform-wide observer (§38)
  return connection.scope === "GLOBAL" || connection.ownerDepartmentId === ctx.officer.departmentId;
}

/**
 * Operational access: permission + department scoping + per-connection
 * operation gate. Audits the denial and throws a generic 403.
 */
export async function assertConnectionAccess(
  ctx: AuthContext,
  connection: IntegrationConnection,
  permission: Permission,
  operation: "read" | "test" | "import" | "export" | "configure" | "admin"
): Promise<void> {
  let denialCode: string | null = null;

  if (!roleHas(ctx.officer.role, permission)) {
    denialCode = "ROLE_PERMISSION_MISSING";
  } else if (!isSystemAdmin(ctx) && ctx.officer.role !== "AUDITOR") {
    if (connection.scope !== "GLOBAL" && connection.ownerDepartmentId !== ctx.officer.departmentId) {
      denialCode = "DEPARTMENT_SCOPE"; // §39/§57
    }
  }
  // AUDITOR may read anything, but never operate:
  if (ctx.officer.role === "AUDITOR" && (operation !== "read" || permission !== ("integration.read" as Permission))) {
    denialCode = denialCode || "AUDITOR_READ_ONLY";
  }
  // GLOBAL-scope configuration is a platform (SYSTEM_ADMIN) decision.
  if (
    operation === "configure" &&
    !isSystemAdmin(ctx) &&
    (connection.scope === "GLOBAL" || connection.ownerDepartmentId !== ctx.officer.departmentId)
  ) {
    denialCode = denialCode || "CONFIGURE_SCOPE";
  }
  if (!denialCode && operation !== "read" && operation !== "configure" && operation !== "admin") {
    const ops = (connection.allowedOperations || "").split(",").map((s) => s.trim());
    if (!ops.includes(operation)) denialCode = "OPERATION_NOT_ALLOWED";
  }
  if (!denialCode && !connection.enabled && operation !== "read" && operation !== "configure" && operation !== "admin") {
    denialCode = "CONNECTION_DISABLED";
  }

  if (denialCode) {
    await recordAuditEvent({
      eventType: "INTEGRATION_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { connectionId: connection.connectionId, operation, reason: denialCode, providerType: connection.providerType },
    });
    throw new ApiError(403, "INTEGRATION_ACCESS_DENIED", "You are not authorized to perform this integration operation.");
  }
}

export function parseConnectionConfig(configJson: string | null): Record<string, unknown> {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Test-infra bypass for expensive-operation rate limits — mirrors the
 * login route convention (TEST_RATELIMIT_BYPASS_KEY). Never honors the
 * header unless the server explicitly configured the key.
 */
export function integrationRateLimitBypass(req: Request): boolean {
  const key = process.env.TEST_RATELIMIT_BYPASS_KEY;
  return !!key && req.headers.get("x-test-bypass-rate-limit") === key;
}
