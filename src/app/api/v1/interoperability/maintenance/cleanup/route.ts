import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopExportService } from "@/lib/interop/export-service";
import { recordAuditEvent } from "@/lib/audit/service";

export const runtime = "nodejs";

// POST /api/v1/interoperability/maintenance/cleanup — SYSTEM_ADMIN
// manual trigger for the expiration sweep (§53/§54). Expired export
// packages: files deleted, jobs marked EXPIRED, audit rows retained.
// (The sandbox has no cron scheduler; the sweep also runs lazily on
// list/download — documented as the production-work gap it is.)
export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_EXPORT);
    if (ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, "ADMIN_ONLY", "Only a system administrator can trigger package cleanup.");
    }
    const result = await interopExportService.sweepExpired();
    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_EXPIRED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      metadata: { reason: "MAINTENANCE_SWEEP", expired: result.expired },
    });
    return jsonOk(result);
  } catch (err) {
    return handleApiError(err);
  }
}
