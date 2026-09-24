import { NextResponse } from "next/server";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAuth, revokeSession, getCookie, clientIp } from "@/lib/auth";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { SESSION_COOKIE } from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/auth/logout (spec §18)
// Revokes the server-side session — the client cannot remain
// authenticated simply by keeping a page open.
export async function POST(req: Request) {
  try {
    const token = getCookie(req, SESSION_COOKIE);
    let ctx = null;
    try {
      ctx = await requireAuth(req);
    } catch {
      // already unauthenticated — still clear the cookie below
    }
    if (ctx) {
      await revokeSession(ctx.sessionId);
      await recordIdentityEvent({
        eventType: IDENTITY_EVENTS.LOGOUT,
        actorOfficerId: ctx.officer.id,
        actorIdentifier: ctx.officer.email,
        departmentId: ctx.officer.departmentId,
        ipAddress: clientIp(req),
        userAgent: req.headers.get("user-agent"),
        metadata: { sessionId: ctx.sessionId },
      });
    }
    const response = jsonOk({ loggedOut: true });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
