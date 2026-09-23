import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAuth, revokeSession, issueSession, sessionCookieOptions, getCookie, clientIp } from "@/lib/auth";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { SESSION_COOKIE } from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/auth/refresh — sliding session renewal.
// Revokes the old session row and issues a fresh one; the
// database session remains the single source of truth.
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req);

    const { token, expiresAt, sessionId } = await issueSession(ctx.officer.id, ctx.officer.departmentId, {
      userAgent: req.headers.get("user-agent"),
      ipAddress: clientIp(req),
    });

    await revokeSession(ctx.sessionId);
    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.SESSION_REFRESHED,
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.email,
      departmentId: ctx.officer.departmentId,
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      metadata: { oldSessionId: ctx.sessionId, newSessionId: sessionId },
    });

    const response = jsonOk({ expiresAt });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
