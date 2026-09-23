import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { loginSchema } from "@/lib/validation";
import { verifyPassword, issueSession, sessionCookieOptions, clientIp } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { SESSION_COOKIE, AUTH_ALLOWED_STATUSES } from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/auth/login  (spec §17)
// Generic failure responses — never reveal whether an email exists.
export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent");

    const body = await req.json().catch(() => ({}));
    const { email, password } = loginSchema.parse(body);

    // Rate limiting (spec §46): per IP+email and per IP.
    // Test determinism: an explicit bypass key (sent as header) is honored
    // ONLY outside production so automated suites don't exhaust the
    // shared-IP budget. Production behavior is unchanged.
    const bypassKey = process.env.TEST_RATELIMIT_BYPASS_KEY;
    const bypass =
      process.env.NODE_ENV !== "production" &&
      !!bypassKey &&
      req.headers.get("x-test-bypass-rate-limit") === bypassKey;
    if (!bypass) {
      const rl1 = rateLimit(`login:ie:${ip}:${email}`, 8, 5 * 60_000);
      const rl2 = rateLimit(`login:ip:${ip}`, 30, 5 * 60_000);
      if (!rl1.allowed || !rl2.allowed) {
        await recordIdentityEvent({
          eventType: IDENTITY_EVENTS.LOGIN_RATE_LIMITED,
          actorIdentifier: email,
          ipAddress: ip,
          userAgent,
        });
        throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please try again later.");
      }
    }

    const officer = await db.officer.findUnique({
      where: { email },
      include: { department: true },
    });

    const passwordOk = officer ? verifyPassword(password, officer.passwordHash) : false;

    if (!officer || !passwordOk) {
      await recordIdentityEvent({
        eventType: IDENTITY_EVENTS.LOGIN_FAILED,
        actorIdentifier: email,
        ipAddress: ip,
        userAgent,
        metadata: { reason: officer ? "BAD_PASSWORD" : "UNKNOWN_EMAIL" },
      });
      // identical response for unknown email and wrong password
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    if (!AUTH_ALLOWED_STATUSES.includes(officer.status)) {
      await recordIdentityEvent({
        eventType: IDENTITY_EVENTS.LOGIN_BLOCKED_INACTIVE,
        actorOfficerId: officer.id,
        actorIdentifier: officer.email,
        departmentId: officer.departmentId,
        ipAddress: ip,
        userAgent,
        metadata: { status: officer.status },
      });
      throw new ApiError(401, "ACCOUNT_INACTIVE", "Account is not permitted to sign in.");
    }

    const { token, expiresAt, sessionId } = await issueSession(officer.id, officer.departmentId, {
      userAgent,
      ipAddress: ip,
    });

    await db.officer.update({ where: { id: officer.id }, data: { lastLoginAt: new Date() } });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.LOGIN_SUCCESS,
      actorOfficerId: officer.id,
      actorIdentifier: officer.email,
      departmentId: officer.departmentId,
      ipAddress: ip,
      userAgent,
      metadata: { sessionId },
    });

    const response = jsonOk({
      officer: {
        officerId: officer.officerId,
        name: officer.name,
        role: officer.role,
      },
      expiresAt,
    });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
