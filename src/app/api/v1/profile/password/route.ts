import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, verifyPassword, hashPassword, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { changePasswordSchema } from "@/lib/validation";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// POST /api/v1/profile/password — change own password (spec §30).
// Requires the CURRENT password; the caller's identity is derived
// server-side from the session. This dedicated sub-path matches the
// documented surface — the base /api/v1/profile route carries only
// GET/PATCH (read + phone update).
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.PASSWORD_UPDATE);
    const body = await req.json().catch(() => ({}));
    const { currentPassword, newPassword } = changePasswordSchema.parse(body);

    const officer = await db.officer.findUnique({ where: { id: ctx.officer.id } });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

    if (!verifyPassword(currentPassword, officer.passwordHash)) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
    }

    await db.officer.update({
      where: { id: officer.id },
      data: { passwordHash: hashPassword(newPassword) },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_PASSWORD_CHANGED,
      actorOfficerId: officer.id,
      departmentId: officer.departmentId,
      targetType: "OFFICER",
      targetId: officer.id,
      metadata: { self: true },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk({ changed: true });
  } catch (err) {
    return handleApiError(err);
  }
}
