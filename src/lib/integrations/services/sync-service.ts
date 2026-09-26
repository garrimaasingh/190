import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { assertConnectionAccess } from "../authorization";
import { getProviderOrThrow } from "../registry";
import { integrationConnectionService } from "./connection-service";
import { integrationMappingService } from "../mapping";
import { integrationConflictService } from "./conflict-service";
import { INTEGRATION_SYNC_MIN_FREQUENCY_MINUTES, INTEGRATION_SYNC_MAX_FREQUENCY_MINUTES } from "@/lib/constants";
import type { Permission } from "@/lib/permissions";

// ============================================================
// Phase 8 — Polling / synchronization (spec §33/§34).
//
// - Schedules carry an explicit frequency, CLAMPED to the provider's
//   declared minimum polling interval (never poll beyond limits).
// - Incremental sync uses the provider's cursor (updated_since) via
//   IntegrationSyncCursor — never re-downloads the entire dataset.
// - Changed external cases are LINKED to their central records via
//   ExternalCaseReference and diffs become CONFLICTS — sync never
//   silently overwrites central data (§22/§15).
// ============================================================

export const integrationSyncService = {
  async ensureSchedule(ctx: AuthContext, connectionRef: string, frequencyMinutes?: number) {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, "integration.configure" as Permission, "configure");
    const provider = getProviderOrThrow(connection.providerType);
    const requested = frequencyMinutes ?? 60;
    const clamped = Math.min(
      INTEGRATION_SYNC_MAX_FREQUENCY_MINUTES,
      Math.max(INTEGRATION_SYNC_MIN_FREQUENCY_MINUTES, provider.minPollingIntervalMinutes, requested)
    );
    const nextRunAt = new Date(Date.now() + clamped * 60_000);
    const schedule = await db.integrationSyncSchedule.upsert({
      where: { connectionId: connection.id },
      create: {
        connectionId: connection.id,
        providerType: connection.providerType,
        syncType: provider.capabilities.supports_webhooks ? "WEBHOOK_ASSISTED" : "POLLING",
        frequencyMinutes: clamped,
        enabled: true,
        nextRunAt,
      },
      update: { frequencyMinutes: clamped, enabled: true, nextRunAt },
    });
    return schedule;
  },

  /**
   * Run one incremental sync cycle: cursor → changed external cases →
   * link + conflict detection → cursor advance.
   */
  async runSync(ctx: AuthContext, connectionRef: string) {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, "integration.test" as Permission, "test");
    integrationConnectionService.assertEnvironmentSafety(connection);

    const provider = getProviderOrThrow(connection.providerType);
    if (!provider.searchCases || !provider.capabilities.supports_polling) {
      throw new ApiError(409, "SYNC_UNSUPPORTED", "The provider does not support polling synchronization.");
    }

    const cursorRow = await db.integrationSyncCursor.findUnique({
      where: { connectionId_resourceType: { connectionId: connection.id, resourceType: "CASE" } },
    });
    const cursorValue = cursorRow?.cursorValue ?? null;

    await recordAuditEvent({
      eventType: "INTEGRATION_SYNC_STARTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { connectionId: connection.connectionId, providerType: connection.providerType, hasCursor: !!cursorValue },
    });

    const outcome = await integrationConnectionService.runProviderCall(connection, "search_cases", (p, c) =>
      p.searchCases!(c, { updatedSince: cursorValue ?? undefined, pageSize: 50 })
    );

    if (!outcome.ok || !outcome.value) {
      await db.integrationSyncSchedule.updateMany({ where: { connectionId: connection.id }, data: { lastRunAt: new Date() } });
      await recordAuditEvent({
        eventType: "INTEGRATION_SYNC_FAILED",
        actorOfficerId: ctx.officer.id,
        result: "FAILED",
        metadata: { connectionId: connection.connectionId, errorCategory: outcome.errorCategory, detail: outcome.errorDetail?.slice(0, 200) },
      });
      return { synced: false, checked: 0, conflicts: 0, linked: 0, errorCategory: outcome.errorCategory, errorDetail: outcome.errorDetail };
    }

    const changed = outcome.value.items;
    let conflicts = 0;
    let linked = 0;
    const mapping = await integrationMappingService.getActiveMapping(connection.providerType, "case_import");
    const mappingVersion = mapping?.mappingVersion ?? null;

    for (const externalCase of changed) {
      const ref = await db.externalCaseReference.findUnique({
        where: { providerType_externalSystem_externalCaseId: { providerType: connection.providerType, externalSystem: connection.connectionId, externalCaseId: externalCase.externalCaseId } },
        include: { case: { select: { id: true, caseId: true, title: true } } },
      });
      if (!ref) continue; // not imported here — syncing links EXISTING imports only
      linked += 1;

      // Refresh the external snapshot through getCase (capability-gated).
      if (provider.getCase && provider.capabilities.can_read_case) {
        const full = await integrationConnectionService.runProviderCall(connection, "get_case", (p, c) => p.getCase!(c, externalCase.externalCaseId));
        if (full.ok && full.value) {
          const mapped = mapping ? integrationMappingService.mapRecord(mapping.mappings, full.value as unknown as Record<string, unknown>) : null;
          if (mapped && mapped.values.title && typeof mapped.values.title === "string" && mapped.values.title.trim() !== ref.case.title.trim()) {
            await integrationConflictService.createConflicts([
              {
                connectionRef: connection.connectionId,
                providerType: connection.providerType,
                externalReference: externalCase.externalCaseId,
                caseRef: ref.case.caseId,
                fieldName: "title",
                centralValue: ref.case.title,
                externalValue: mapped.values.title.slice(0, 300),
                externalUpdatedAt: full.value.updatedAt ? new Date(full.value.updatedAt) : null,
              },
            ]);
            conflicts += 1;
          }
          await db.externalCaseReference.update({
            where: { id: ref.id },
            data: { lastSyncedAt: new Date(), ...(mappingVersion ? { mappingVersion } : {}) },
          }).catch(() => undefined);
        }
      }
    }

    // Cursor advance (§34) — reuse provider nextCursor when provided.
    const newCursor = outcome.value.nextCursor ?? new Date().toISOString();
    await db.integrationSyncCursor.upsert({
      where: { connectionId_resourceType: { connectionId: connection.id, resourceType: "CASE" } },
      create: { connectionId: connection.id, providerType: connection.providerType, resourceType: "CASE", cursorValue: newCursor, lastSuccessfulSync: new Date() },
      update: { cursorValue: newCursor, lastSuccessfulSync: new Date() },
    });
    await db.integrationSyncSchedule.updateMany({ where: { connectionId: connection.id }, data: { lastRunAt: new Date(), nextRunAt: new Date(Date.now() + 60 * 60_000) } });

    await recordAuditEvent({
      eventType: "INTEGRATION_SYNC_COMPLETED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { connectionId: connection.connectionId, checked: changed.length, linked, conflicts },
    });

    return { synced: true, checked: changed.length, linked, conflicts, errorCategory: null as string | null, errorDetail: null as string | null };
  },
};
