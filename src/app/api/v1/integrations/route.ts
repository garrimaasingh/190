import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAuth, requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { INTEGRATION_PROVIDER_TYPES, INTEGRATION_ENVIRONMENTS, INTEGRATION_AUTH_TYPES, INTEGRATION_SCOPES } from "@/lib/constants";
import { recordAuditEvent } from "@/lib/audit/service";
import { getProviderOrThrow, listRegisteredProviderTypes } from "@/lib/integrations/registry";
import { integrationCredentialService } from "@/lib/integrations/credentials";
import { generateConnectionId } from "@/lib/integrations/ids";
import { connectionVisibleTo, isSystemAdmin } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// ============================================================
// GET  /api/v1/integrations — scoped connection directory (§40)
// POST /api/v1/integrations — configure a connection (§6/§47)
// ============================================================

const PROVIDER_MODES = ["MOCK", "SANDBOX", "REAL"] as const;

const createSchema = z
  .object({
    providerType: z.enum(INTEGRATION_PROVIDER_TYPES),
    displayName: z.string().trim().min(3).max(120),
    environment: z.enum(INTEGRATION_ENVIRONMENTS),
    providerMode: z.enum(PROVIDER_MODES).default("MOCK"),
    scope: z.enum(INTEGRATION_SCOPES).default("DEPARTMENT"),
    authenticationType: z.enum(INTEGRATION_AUTH_TYPES).default("NONE"),
    baseUrlReference: z.string().trim().max(300).optional().nullable(),
    allowedOperations: z.string().trim().max(100).default("read,test,import,export"),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z
      .object({
        apiKey: z.string().min(8).max(400).optional(),
        webhookSecret: z.string().min(8).max(400).optional(),
      })
      .optional(),
    /** Explicit confirmation required for PRODUCTION environments (§8/§70). */
    confirmProduction: z.boolean().optional(),
  })
  .strict();

const credentialShapedKeys = /(apikey|webhooksecret|secret|password|token)/i;

function sanitizeConfig(config: Record<string, unknown> | undefined): string | null {
  if (!config) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (credentialShapedKeys.test(k)) continue; // never persist secret-shaped config
    clean[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/** API-facing projection — credentialRef/credentials NEVER leave the server (§7/§40). */
function toConnectionSummary(c: {
  connectionId: string; providerType: string; providerMode: string; displayName: string; environment: string;
  status: string; authenticationType: string; ownerDepartmentId: string; scope: string; allowedOperations: string;
  capabilitiesSnapshot: string | null; enabled: boolean; lastHealthCheckAt: Date | null; lastHealthStatus: string | null;
  lastHealthLatencyMs: number | null; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastErrorCategory: string | null;
  createdAt: Date; baseUrlReference: string | null;
}) {
  let capabilities = null;
  if (c.capabilitiesSnapshot) {
    try { capabilities = JSON.parse(c.capabilitiesSnapshot); } catch { capabilities = null; }
  }
  return {
    connectionId: c.connectionId,
    providerType: c.providerType,
    providerMode: c.providerMode, // MOCK | SANDBOX | REAL — MUST be displayed (§71)
    displayName: c.displayName,
    environment: c.environment,
    status: c.status,
    authenticationType: c.authenticationType,
    scope: c.scope,
    allowedOperations: (c.allowedOperations || "").split(",").map((s) => s.trim()),
    capabilities,
    enabled: c.enabled,
    health: {
      lastCheckAt: c.lastHealthCheckAt,
      lastStatus: c.lastHealthStatus,
      lastLatencyMs: c.lastHealthLatencyMs,
      lastSuccessAt: c.lastSuccessAt,
      lastFailureAt: c.lastFailureAt,
      lastErrorCategory: c.lastErrorCategory,
    },
    baseUrlReference: c.baseUrlReference,
    createdAt: c.createdAt,
  };
}

export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const rows = await db.integrationConnection.findMany({
      orderBy: { createdAt: "asc" },
      include: { ownerDepartment: { select: { departmentCode: true, name: true } } },
    });
    const items = rows
      .filter((r) => connectionVisibleTo(ctx, r))
      .map((r) => ({ ...toConnectionSummary(r), ownerDepartment: { code: r.ownerDepartment.departmentCode, name: r.ownerDepartment.name } }));
    const [pendingImports, pendingExports, openConflicts] = await Promise.all([
      db.integrationImportJob.count({ where: { status: { in: ["QUEUED", "PROCESSING"] } } }),
      db.integrationExportJob.count({ where: { status: { in: ["QUEUED", "PROCESSING"] } } }),
      db.integrationConflict.count({ where: { status: "OPEN" } }),
    ]);
    return jsonOk({
      items,
      summary: { total: items.length, connected: items.filter((i) => i.status === "CONNECTED").length, pendingImports, pendingExports, openConflicts },
      registeredProviderTypes: listRegisteredProviderTypes(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_CONFIGURE);
    const body = createSchema.parse(await req.json());

    if (!getProviderOrThrowSafe(body.providerType)) {
      throw new ApiError(422, "PROVIDER_NOT_REGISTERED", "Provider type is not registered in the integration registry.");
    }
    if (body.providerMode === "REAL") {
      throw new ApiError(422, "REAL_PROVIDER_NOT_AVAILABLE", "No verified real government interface is configured on this platform. Only MOCK providers are available.");
    }
    if (body.providerMode === "MOCK" && body.environment === "PRODUCTION") {
      throw new ApiError(422, "ENVIRONMENT_MODE_CONFLICT", "A MOCK provider cannot be configured as PRODUCTION.");
    }
    if (body.environment === "PRODUCTION" && body.confirmProduction !== true) {
      throw new ApiError(422, "PRODUCTION_NOT_CONFIRMED", "Production integrations require explicit confirmation (confirmProduction).");
    }
    // Department scoping on create (§39): GLOBAL scope is a platform decision.
    if (body.scope === "GLOBAL" && !isSystemAdmin(ctx)) {
      throw new ApiError(403, "INTEGRATION_ACCESS_DENIED", "Only platform administrators may create GLOBAL connections.");
    }

    const connectionId = await generateConnectionId();
    const connection = await db.integrationConnection.create({
      data: {
        connectionId,
        providerType: body.providerType,
        providerMode: body.providerMode,
        displayName: body.displayName,
        environment: body.environment,
        status: "CONFIGURED",
        authenticationType: body.authenticationType,
        baseUrlReference: body.baseUrlReference ?? `mock://${body.providerType.toLowerCase().replace(/_/g, "")}/sandbox`,
        ownerDepartmentId: ctx.officer.departmentId,
        scope: body.scope,
        allowedOperations: body.allowedOperations,
        configJson: sanitizeConfig(body.config),
        enabled: true,
        createdByOfficerId: ctx.officer.id,
      },
    });

    if (body.credentials && (body.credentials.apiKey || body.credentials.webhookSecret)) {
      await integrationCredentialService.setCredentials(connectionId, {
        authType: body.authenticationType,
        ...(body.credentials.apiKey ? { apiKey: body.credentials.apiKey } : {}),
        ...(body.credentials.webhookSecret ? { webhookSecret: body.credentials.webhookSecret } : {}),
      });
      await db.integrationConnection.update({ where: { id: connection.id }, data: { credentialRef: `secret://integrations/${connectionId}`, hasWebhookSecret: !!body.credentials.webhookSecret } });
    }

    await recordAuditEvent({
      eventType: "INTEGRATION_CONNECTION_CREATED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      ipAddress: clientIp(req),
      metadata: { connectionId, providerType: body.providerType, providerMode: body.providerMode, environment: body.environment, scope: body.scope },
    });

    const fresh = await db.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    return jsonOk(toConnectionSummary(fresh), 201);
  } catch (err) {
    return handleApiError(err);
  }
}

function getProviderOrThrowSafe(providerType: string) {
  try {
    return getProviderOrThrow(providerType);
  } catch {
    return null;
  }
}

void requireAuth;
