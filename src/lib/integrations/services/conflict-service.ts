import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { generateConflictId } from "../ids";
import { assertCaseManage } from "@/lib/cases/access";
import { ApiError } from "@/lib/api";
import type { IntegrationConflict } from "@prisma/client";

// ============================================================
// Phase 8 — Conflict management (spec §22/§23).
//
// External data NEVER silently overwrites authoritative central
// data. A differing field produces an OPEN conflict holding BOTH
// values, their sources and timestamps. Resolution is a separate,
// authorized, audited human act:
//   RESOLVED_CENTRAL — central value stands (external ignored)
//   RESOLVED_EXTERNAL — external value applied to the central record
//   MERGED — reviewer supplied a merged value (applied)
//   IGNORED — no change, conflict closed as noise
// ============================================================

export interface ConflictDraft {
  connectionRef?: string | null;
  importJobId?: string | null;
  importRecordId?: string | null;
  caseRef?: string | null;
  documentRef?: string | null;
  evidenceRef?: string | null;
  providerType: string;
  externalReference?: string | null;
  fieldName: string;
  centralValue?: string | null;
  externalValue?: string | null;
  centralUpdatedAt?: Date | null;
  externalUpdatedAt?: Date | null;
}

export const integrationConflictService = {
  /** Create OPEN conflicts for a staged record (idempotent per job+field+target). */
  async createConflicts(drafts: ConflictDraft[]): Promise<string[]> {
    const created: string[] = [];
    for (const d of drafts) {
      const existing = await db.integrationConflict.findFirst({
        where: {
          status: "OPEN",
          fieldName: d.fieldName,
          providerType: d.providerType,
          caseRef: d.caseRef ?? null,
          documentRef: d.documentRef ?? null,
          evidenceRef: d.evidenceRef ?? null,
        },
        select: { id: true },
      });
      if (existing) {
        created.push(existing.id);
        continue;
      }
      const row = await db.integrationConflict.create({
        data: {
          conflictId: await generateConflictId(),
          importJobId: d.importJobId ?? null,
          importRecordId: d.importRecordId ?? null,
          caseRef: d.caseRef ?? null,
          documentRef: d.documentRef ?? null,
          evidenceRef: d.evidenceRef ?? null,
          providerType: d.providerType,
          externalReference: d.externalReference ?? null,
          fieldName: d.fieldName,
          centralValue: d.centralValue ?? null,
          externalValue: d.externalValue ?? null,
          centralUpdatedAt: d.centralUpdatedAt ?? null,
          externalUpdatedAt: d.externalUpdatedAt ?? null,
          status: "OPEN",
        },
      });
      await recordAuditEvent({
        eventType: "INTEGRATION_CONFLICT_CREATED",
        actorOfficerId: null,
        caseId: d.caseRef ?? null,
        documentId: d.documentRef ?? null,
        evidenceId: d.evidenceRef ?? null,
        metadata: {
          conflictId: row.conflictId,
          connectionId: d.connectionRef ?? null,
          providerType: d.providerType,
          fieldName: d.fieldName,
          externalReference: d.externalReference ?? null,
        },
      });
      created.push(row.id);
    }
    return created;
  },

  async listConflicts(params: { status?: string; caseRef?: string; page?: number; pageSize?: number }) {
    const where = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.caseRef ? { caseRef: params.caseRef } : {}),
    };
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const page = Math.max(1, params.page ?? 1);
    const [items, total] = await Promise.all([
      db.integrationConflict.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { resolvedByOfficer: { select: { officerId: true, name: true } } },
      }),
      db.integrationConflict.count({ where }),
    ]);
    return { items, total, page, pageSize };
  },

  async getConflict(conflictId: string): Promise<IntegrationConflict | null> {
    return db.integrationConflict.findUnique({ where: { conflictId }, include: { resolvedByOfficer: { select: { officerId: true, name: true } } } });
  },

  /**
   * Resolve a conflict. RESOLVED_EXTERNAL/MERGED APPLY the external
   * value to the central record — currently the case title field
   * (the only centrally-mutable mapped field) — as an audited update
   * by the resolver. Everything else keeps the central record.
   */
  async resolveConflict(ctx: AuthContext, conflictRef: string, resolution: "RESOLVED_CENTRAL" | "RESOLVED_EXTERNAL" | "MERGED" | "IGNORED", note: string | null, mergedValue?: string | null) {
    const conflict = await db.integrationConflict.findUnique({ where: { conflictId: conflictRef } });
    if (!conflict) throw new Error("CONFLICT_NOT_FOUND");
    if (conflict.status !== "OPEN") throw new Error("CONFLICT_ALREADY_RESOLVED");

    // §39/§38: conflict resolution on a CASE is a case-management act —
    // the resolver must hold case-level manage access (department
    // scoping is inherited from the case access model). Conflicts not
    // bound to a case require platform administration.
    if (conflict.caseRef) {
      await assertCaseManage(ctx, conflict.caseRef);
    } else if (ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, "INTEGRATION_ACCESS_DENIED", "You are not authorized to perform this integration operation.");
    }

    let applied = false;
    if ((resolution === "RESOLVED_EXTERNAL" || resolution === "MERGED") && conflict.caseRef && conflict.fieldName === "title") {
      const newValue = resolution === "MERGED" ? (mergedValue ?? null) : conflict.externalValue;
      if (newValue) {
        const target = await db.case.findFirst({ where: { caseId: conflict.caseRef }, select: { id: true } });
        if (target) {
          await db.case.update({ where: { id: target.id }, data: { title: newValue.slice(0, 200) } });
          applied = true;
        }
      }
    }

    const updated = await db.integrationConflict.update({
      where: { id: conflict.id },
      data: {
        status: resolution,
        resolvedByOfficerId: ctx.officer.id,
        resolvedAt: new Date(),
        resolutionNote: note?.slice(0, 500) ?? null,
      },
    });

    if (conflict.importRecordId) {
      await db.integrationImportRecord
        .update({ where: { id: conflict.importRecordId }, data: { conflictStatus: "RESOLVED" } })
        .catch(() => undefined);
    }

    // Resolve the owning connection reference for the audit trail.
    let connectionRef: string | null = null;
    if (conflict.importJobId) {
      const job = await db.integrationImportJob.findUnique({ where: { id: conflict.importJobId }, include: { connection: { select: { connectionId: true } } } });
      connectionRef = job?.connection.connectionId ?? null;
    }
    if (!connectionRef && conflict.caseRef && conflict.providerType) {
      // Sync-detected conflicts carry no import job — resolve the owning
      // connection through the external case reference instead.
      const ref = await db.externalCaseReference.findFirst({
        where: { providerType: conflict.providerType, case: { caseId: conflict.caseRef } },
        select: { externalSystem: true },
      });
      connectionRef = ref?.externalSystem ?? null;
    }

    await recordAuditEvent({
      eventType: "INTEGRATION_CONFLICT_RESOLVED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      caseId: conflict.caseRef,
      documentId: conflict.documentRef,
      evidenceId: conflict.evidenceRef,
      metadata: { conflictId: conflict.conflictId, connectionId: connectionRef, resolution, applied, fieldName: conflict.fieldName },
    });

    return { conflict: updated, applied };
  },
};
