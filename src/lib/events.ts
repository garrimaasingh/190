import { db } from "@/lib/db";

// ============================================================
// Identity event interface (spec §45).
// Structured, audit-ready events. Phase 4 will connect this
// sink to the immutable audit infrastructure — the interface
// stays stable; only the sink implementation changes.
// ============================================================

export const IDENTITY_EVENTS = {
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGIN_BLOCKED_INACTIVE: "LOGIN_BLOCKED_INACTIVE",
  LOGIN_RATE_LIMITED: "LOGIN_RATE_LIMITED",
  LOGOUT: "LOGOUT",
  SESSION_REFRESHED: "SESSION_REFRESHED",
  OFFICER_CREATED: "OFFICER_CREATED",
  OFFICER_UPDATED: "OFFICER_UPDATED",
  OFFICER_STATUS_CHANGED: "OFFICER_STATUS_CHANGED",
  OFFICER_PASSWORD_CHANGED: "OFFICER_PASSWORD_CHANGED",
  DEPARTMENT_CREATED: "DEPARTMENT_CREATED",
  DEPARTMENT_UPDATED: "DEPARTMENT_UPDATED",
  DEPARTMENT_STATUS_CHANGED: "DEPARTMENT_STATUS_CHANGED",
  DEPARTMENT_LOGO_UPDATED: "DEPARTMENT_LOGO_UPDATED",
  GEOGRAPHY_CREATED: "GEOGRAPHY_CREATED",
} as const;

export type IdentityEventType = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];

export interface IdentityEventInput {
  eventType: IdentityEventType;
  actorOfficerId?: string | null;
  actorIdentifier?: string | null;
  departmentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordIdentityEvent(input: IdentityEventInput): Promise<void> {
  // Fire-and-forget: event failure must never break the primary operation.
  try {
    await db.identityEvent.create({
      data: {
        eventType: input.eventType,
        actorOfficerId: input.actorOfficerId ?? null,
        actorIdentifier: input.actorIdentifier ?? null,
        departmentId: input.departmentId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ipAddress: input.ipAddress?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 400) ?? null,
      },
    });
  } catch (err) {
    console.error("[identity-event] failed to record", input.eventType, err);
  }
}
