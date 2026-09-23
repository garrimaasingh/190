import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateOfficerStatusSchema } from "@/lib/validation";
import { assertDepartmentScope } from "@/lib/scope";
import { OFFICER_STATUS_TRANSITIONS } from "@/lib/constants";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// PATCH /api/v1/officers/{officerId}/status — lifecycle (spec §25)
// PENDING → ACTIVE → SUSPENDED → INACTIVE (with defined re-activation paths).
// Status changes that remove ACTIVE standing also revoke live sessions.
export async function PATCH(req: Request, { params }: { params: Promise<{ officerId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_ACTIVATE);
    const { officerId: officerDbId } = await params;

    const officer = await db.officer.findUnique({ where: { id: officerDbId } });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Officer not found.");

    assertDepartmentScope(ctx, officer.departmentId);

    if (officer.role === "SYSTEM_ADMIN") {
      throw new ApiError(403, "FORBIDDEN", "The platform system administrator cannot be modified here.");
    }

    const body = await req.json().catch(() => ({}));
    const { status } = updateOfficerStatusSchema.parse(body);

    const allowed = OFFICER_STATUS_TRANSITIONS[officer.status] || [];
    if (!allowed.includes(status)) {
      throw new ApiError(
        422,
        "INVALID_STATUS_TRANSITION",
        `Cannot transition officer from ${officer.status} to ${status}.`
      );
    }

    const updated = await db.officer.update({
      where: { id: officer.id },
      data: { status },
      select: {
        id: true, officerId: true, name: true, role: true, status: true, departmentId: true,
      },
    });

    if (status !== "ACTIVE") {
      // Deactivated officers must lose all live sessions immediately.
      await db.session.updateMany({
        where: { officerId: officer.id, revoked: false },
        data: { revoked: true, revokedAt: new Date() },
      });
    }

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.OFFICER_STATUS_CHANGED,
      actorOfficerId: ctx.officer.id,
      departmentId: officer.departmentId,
      targetType: "OFFICER",
      targetId: officer.id,
      metadata: { officerId: officer.officerId, from: officer.status, to: status },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
