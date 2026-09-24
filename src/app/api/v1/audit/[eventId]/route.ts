import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ERROR_CODES } from "@/lib/constants";
import { recordAuditEvent } from "@/lib/audit/service";
import { verifyEvent } from "@/lib/audit/integrity";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/audit/{eventId} — single event detail (spec §35):
// every field of the audit record EXCEPT security secrets (none are
// ever stored — spec §23/§50). Includes self-hash verification info.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.AUDIT_READ);
    const { eventId } = await params;

    const event = await db.auditEvent.findFirst({
      where: { OR: [{ eventId }, { id: eventId }] },
      include: {
        actorOfficer: { select: { officerId: true, name: true } },
      },
    });
    if (!event) {
      throw new ApiError(404, ERROR_CODES.AUDIT_NOT_FOUND, "Audit event not found.");
    }

    const selfCheck = await verifyEvent(event.eventId);

    await recordAuditEvent({
      eventType: "AUDIT_EVENT_VIEWED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { auditedEventId: event.eventId },
    });

    return jsonOk({
      event: {
        eventId: event.eventId,
        sequence: event.sequence,
        eventType: event.eventType,
        actor: event.actorOfficer ? { officerId: event.actorOfficer.officerId, name: event.actorOfficer.name } : null,
        actorIdentifier: event.actorIdentifier,
        actorDepartmentId: event.actorDepartmentId,
        caseId: event.caseId,
        documentId: event.documentId,
        evidenceId: event.evidenceId,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        result: event.result,
        ipAddress: event.ipAddress,
        deviceId: event.deviceId,
        userAgent: event.userAgent,
        metadata: event.metadata ? (JSON.parse(event.metadata) as Record<string, unknown>) : null,
        previousEventHash: event.previousEventHash,
        eventHash: event.eventHash,
        ledgerStatus: event.ledgerStatus,
        createdAt: event.createdAt,
      },
      integrity: {
        selfHashValid: selfCheck.valid,
        recomputedHash: selfCheck.recomputedHash,
        note: "Self-hash check confirms this event's stored fields match its recorded hash. Full tamper-evidence requires chain verification.",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
