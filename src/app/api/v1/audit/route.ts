import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { auditSearchQuerySchema } from "@/lib/validation";
import { AUDIT_EVENT_CATEGORIES, AUDIT_EVENT_TYPES } from "@/lib/constants";
import { recordAuditEvent } from "@/lib/audit/service";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/audit — audit search & filtering (spec §33/§60).
// AUDITOR + SYSTEM_ADMIN only (spec §34). Search by event id, case,
// document, evidence, officer, department, type, date range, result;
// category filter groups types (LOGIN/CASE/DOCUMENT/EVIDENCE/
// TRANSFER/ACCESS/ADMIN analog → AUTHENTICATION/EVIDENCE/AUDIT/
// LEDGER/REPORT). Server-side pagination (spec §69/§70); metadata
// and hashes are included (auditor-only surface, spec §35).
// AUDIT_SEARCHED is itself audited — the auditors are audited too.
// ============================================================

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.AUDIT_READ);
    const url = new URL(req.url);
    const query = auditSearchQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const categoryTypes = query.category ? AUDIT_EVENT_CATEGORIES[query.category] : undefined;
    if (query.category && !categoryTypes) {
      return jsonOk({ items: [], total: 0, page: query.page, pageSize: query.pageSize, categories: Object.keys(AUDIT_EVENT_CATEGORIES) });
    }

    const where = {
      ...(query.eventId ? { eventId: { contains: query.eventId } } : {}),
      ...(query.eventType && AUDIT_EVENT_TYPES.includes(query.eventType as (typeof AUDIT_EVENT_TYPES)[number]) ? { eventType: query.eventType } : {}),
      ...(categoryTypes ? { eventType: { in: categoryTypes } } : {}),
      ...(query.caseId ? { caseId: { contains: query.caseId } } : {}),
      ...(query.documentId ? { documentId: { contains: query.documentId } } : {}),
      ...(query.evidenceId ? { evidenceId: { contains: query.evidenceId } } : {}),
      ...(query.actorOfficerId ? { actorOfficer: { is: { officerId: query.actorOfficerId } } } : {}),
      ...(query.departmentId ? { actorDepartmentId: query.departmentId } : {}),
      ...(query.result && ["SUCCESS", "DENIED", "FAILED"].includes(query.result) ? { result: query.result } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            timestamp: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(`${query.dateTo}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { eventId: { contains: query.q } },
              { caseId: { contains: query.q } },
              { documentId: { contains: query.q } },
              { evidenceId: { contains: query.q } },
              { eventType: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.auditEvent.findMany({
        where,
        orderBy: { sequence: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          actorOfficer: { select: { officerId: true, name: true } },
        },
      }),
      db.auditEvent.count({ where }),
    ]);

    // Audit the search itself (spec §34: read access is monitored).
    await recordAuditEvent({
      eventType: "AUDIT_SEARCHED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { filters: JSON.stringify(query).slice(0, 400), results: total },
    });

    return jsonOk({
      items: rows.map((r) => ({
        eventId: r.eventId,
        sequence: r.sequence,
        eventType: r.eventType,
        actor: r.actorOfficer ? { officerId: r.actorOfficer.officerId, name: r.actorOfficer.name } : null,
        actorIdentifier: r.actorIdentifier,
        actorDepartmentId: r.actorDepartmentId,
        caseId: r.caseId,
        documentId: r.documentId,
        evidenceId: r.evidenceId,
        sessionId: r.sessionId,
        timestamp: r.timestamp,
        result: r.result,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
        previousEventHash: r.previousEventHash,
        eventHash: r.eventHash,
        ledgerStatus: r.ledgerStatus,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
