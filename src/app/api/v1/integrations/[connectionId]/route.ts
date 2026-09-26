import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { assertConnectionAccess } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// ============================================================
// GET   /api/v1/integrations/[connectionId] — details (§41)
// PATCH /api/v1/integrations/[connectionId] — reconfigure (§47)
// POST  .../test | /sync | /import | /export (§10/§33/§16/§17/§47)
// POST  .../search — external case search (demo §61 step 7)
// GET   .../health | /capabilities
// ============================================================

const patchSchema = z
  .object({
    displayName: z.string().trim().min(3).max(120).optional(),
    environment: z.enum(["DEVELOPMENT", "TEST", "SANDBOX", "PRODUCTION"]).optional(),
    status: z.enum(["CONFIGURED", "DISCONNECTED", "DISABLED"]).optional(),
    enabled: z.boolean().optional(),
    scope: z.enum(["DEPARTMENT", "GLOBAL"]).optional(),
    allowedOperations: z.string().trim().max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z
      .object({
        apiKey: z.string().min(8).max(400).optional(),
        webhookSecret: z.string().min(8).max(400).optional(),
      })
      .optional(),
    confirmProduction: z.boolean().optional(),
  })
  .strict();

const credentialShapedKeys = /(apikey|webhooksecret|secret|password|token)/i;

function sanitizeConfig(config: Record<string, unknown> | undefined | null): string | null | undefined {
  if (config === undefined) return undefined;
  if (config === null) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (credentialShapedKeys.test(k)) continue;
    clean[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

async function loadConnection(connectionId: string) {
  const connection = await db.integrationConnection.findUnique({ where: { connectionId } });
  if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
  return connection;
}

function toDetail(c: Awaited<ReturnType<typeof loadConnection>>) {
  let capabilities = null;
  if (c.capabilitiesSnapshot) {
    try { capabilities = JSON.parse(c.capabilitiesSnapshot); } catch { capabilities = null; }
  }
  return {
    connectionId: c.connectionId,
    providerType: c.providerType,
    providerMode: c.providerMode, // displayed verbatim in the UI (§71)
    displayName: c.displayName,
    environment: c.environment,
    status: c.status,
    authenticationType: c.authenticationType,
    scope: c.scope,
    allowedOperations: (c.allowedOperations || "").split(",").map((s) => s.trim()),
    capabilities,
    enabled: c.enabled,
    hasWebhookSecret: c.hasWebhookSecret,
    health: {
      lastCheckAt: c.lastHealthCheckAt,
      lastStatus: c.lastHealthStatus,
      lastLatencyMs: c.lastHealthLatencyMs,
      lastSuccessAt: c.lastSuccessAt,
      lastFailureAt: c.lastFailureAt,
      lastErrorCategory: c.lastErrorCategory,
      consecutiveFailures: c.consecutiveFailures,
    },
    baseUrlReference: c.baseUrlReference,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { connectionId } = await params;
    const connection = await loadConnection(connectionId);
    await assertConnectionAccess(ctx, connection, PERMISSIONS.INTEGRATION_READ, "read");
    const [recentImports, recentExports, recentConflicts] = await Promise.all([
      db.integrationImportJob.findMany({ where: { connectionId: connection.id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.integrationExportJob.findMany({ where: { connectionId: connection.id }, orderBy: { createdAt: "desc" }, take: 10 }),
      db.integrationConflict.findMany({ where: { providerType: connection.providerType }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);
    return jsonOk({
      connection: toDetail(connection),
      recentImports: recentImports.map((j) => ({ jobId: j.jobId, status: j.status, importType: j.importType, recordsReceived: j.recordsReceived, recordsImported: j.recordsImported, recordsRejected: j.recordsRejected, recordsConflicted: j.recordsConflicted, createdAt: j.createdAt })),
      recentExports: recentExports.map((j) => ({ jobId: j.jobId, status: j.status, exportType: j.exportType, recordsSelected: j.recordsSelected, recordsExported: j.recordsExported, recordsFailed: j.recordsFailed, createdAt: j.createdAt })),
      recentConflicts: recentConflicts.map((c) => ({ conflictId: c.conflictId, fieldName: c.fieldName, status: c.status, caseRef: c.caseRef, createdAt: c.createdAt })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_CONFIGURE);
    const { connectionId } = await params;
    const connection = await loadConnection(connectionId);
    await assertConnectionAccess(ctx, connection, PERMISSIONS.INTEGRATION_CONFIGURE, "configure");
    const body = patchSchema.parse(await req.json());

    if (body.environment === "PRODUCTION" && body.confirmProduction !== true && connection.environment !== "PRODUCTION") {
      throw new ApiError(422, "PRODUCTION_NOT_CONFIRMED", "Production integrations require explicit confirmation (confirmProduction).");
    }
    if (body.scope === "GLOBAL" && !ctx.permissions.includes("integration.admin")) {
      throw new ApiError(403, "INTEGRATION_ACCESS_DENIED", "Only platform administrators may change connection scope.");
    }
    if ((body.environment || connection.environment) === "PRODUCTION" && connection.providerMode === "MOCK" && body.environment) {
      throw new ApiError(422, "ENVIRONMENT_MODE_CONFLICT", "A MOCK provider cannot be configured as PRODUCTION.");
    }

    const data: Record<string, unknown> = {};
    if (body.displayName !== undefined) data.displayName = body.displayName;
    if (body.environment !== undefined) data.environment = body.environment;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.scope !== undefined) data.scope = body.scope;
    if (body.allowedOperations !== undefined) data.allowedOperations = body.allowedOperations;
    if (body.config !== undefined) data.configJson = sanitizeConfig(body.config);
    if (body.status !== undefined) data.status = body.status;
    else if (body.enabled === false) data.status = "DISABLED";

    if (body.credentials) {
      const { integrationCredentialService } = await import("@/lib/integrations/credentials");
      await integrationCredentialService.setCredentials(connectionId, {
        authType: connection.authenticationType,
        ...(body.credentials.apiKey ? { apiKey: body.credentials.apiKey } : {}),
        ...(body.credentials.webhookSecret ? { webhookSecret: body.credentials.webhookSecret } : {}),
      });
      data.credentialRef = `secret://integrations/${connectionId}`;
      if (body.credentials.webhookSecret) data.hasWebhookSecret = true;
    }

    const updated = await db.integrationConnection.update({ where: { id: connection.id }, data });
    await recordAuditEvent({
      eventType: "INTEGRATION_CONNECTION_UPDATED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      ipAddress: clientIp(req),
      metadata: { connectionId, updatedFields: Object.keys(data).filter((k) => k !== "credentialRef") },
    });
    return jsonOk(toDetail(updated));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST() {
  // Actions live in dedicated sub-routes (test/health/capabilities/
  // sync/import/export/search) mirroring spec §47 exactly.
  return Response.json({ error: { code: "NOT_FOUND", message: "Unknown integration action." } }, { status: 404 });
}

