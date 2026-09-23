import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateDepartmentStatusSchema } from "@/lib/validation";
import { assertDepartmentScope } from "@/lib/scope";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";

export const runtime = "nodejs";

// PATCH /api/v1/departments/{departmentId}/status — activate/deactivate (spec §6/§29)
export async function PATCH(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DEPARTMENT_STATUS_UPDATE);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");

    assertDepartmentScope(ctx, department.id);

    const body = await req.json().catch(() => ({}));
    const { status } = updateDepartmentStatusSchema.parse(body);

    if (department.status === status) {
      throw new ApiError(422, "VALIDATION_ERROR", `Department is already ${status}.`);
    }

    const updated = await db.department.update({
      where: { id: department.id },
      data: { status },
    });

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.DEPARTMENT_STATUS_CHANGED,
      actorOfficerId: ctx.officer.id,
      departmentId: department.id,
      targetType: "DEPARTMENT",
      targetId: department.id,
      metadata: { from: department.status, to: status },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
