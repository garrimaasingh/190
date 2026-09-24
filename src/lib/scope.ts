import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";

// ============================================================
// Department-scoped authorization (spec §31).
// Authorization chain: Authentication → User → Officer →
// Department → Permission. A department id supplied by the
// client is NEVER proof of membership; the caller must pass
// the department id of the resource being accessed, and we
// compare it with the server-derived department of the
// authenticated officer.
// ============================================================

export function assertDepartmentScope(ctx: AuthContext, resourceDepartmentId: string): void {
  if (ctx.officer.role === "SYSTEM_ADMIN") return; // platform-wide authority
  if (ctx.officer.role === "AUDITOR") return; // read-only global visibility (write permissions never granted)
  if (ctx.officer.departmentId !== resourceDepartmentId) {
    throw new ApiError(403, ERROR_CODES.FORBIDDEN, "You are not authorized to access this department's resources.");
  }
}

export function isPlatformScoped(ctx: AuthContext): boolean {
  return ctx.officer.role === "SYSTEM_ADMIN" || ctx.officer.role === "AUDITOR";
}
