import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { getProviderOrThrow } from "../registry";
import { integrationCredentialService } from "../credentials";
import { getCircuitBreaker, CircuitOpenError, peekCircuitState } from "../circuit-breaker";
import { executeWithRetry, isRetryableError } from "../retry";
import { ProviderError, DEFAULT_PROVIDER_CONFIG, type IntegrationProvider, type ProviderCallContext, type ProviderRuntimeConfig } from "../provider";
import { assertConnectionAccess, assertIntegrationPermission, isSystemAdmin, parseConnectionConfig } from "../authorization";
import type { Permission } from "@/lib/permissions";
import type { IntegrationEnvironment, IntegrationErrorCategory } from "@/lib/constants";

// ============================================================
// Phase 8 — Connection management + provider-call execution core
// (spec §6/§8/§9/§10/§35/§36/§67/§68).
//
// EVERY provider call flows through runProviderCall():
//   circuit breaker → simulate/bounded-timeout call → retry w/
//   backoff+jitter (transient classes only) → call log + connection
//   health bookkeeping. Integration failures NEVER crash the core
//   platform: all outcomes are captured and surfaced as data.
// ============================================================

function resolveRuntimeConfig(configJson: string | null): ProviderRuntimeConfig {
  const raw = parseConnectionConfig(configJson);
  const num = (key: string, fallback: number, min = 0, max = 120_000): number => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  return {
    timeoutMs: num("timeoutMs", DEFAULT_PROVIDER_CONFIG.timeoutMs, 500, 60_000),
    maxRetries: num("maxRetries", DEFAULT_PROVIDER_CONFIG.maxRetries, 0, 5),
    baseBackoffMs: num("baseBackoffMs", DEFAULT_PROVIDER_CONFIG.baseBackoffMs, 10, 5_000),
    circuitFailureThreshold: num("circuitFailureThreshold", DEFAULT_PROVIDER_CONFIG.circuitFailureThreshold, 1, 20),
    circuitCooldownMs: num("circuitCooldownMs", DEFAULT_PROVIDER_CONFIG.circuitCooldownMs, 100, 600_000),
    // MOCK-only simulation switches:
    latencyMs: typeof raw.latencyMs === "number" ? raw.latencyMs : undefined,
    failNext: typeof raw.failNext === "number" ? raw.failNext : undefined,
    rateLimitPerMinute: typeof raw.rateLimitPerMinute === "number" ? raw.rateLimitPerMinute : undefined,
    scenarioSchemaVersion: typeof raw.scenarioSchemaVersion === "string" ? raw.scenarioSchemaVersion : undefined,
    // §55 simulation: external system reports a wrong hash for this document id.
    corruptDocumentHashFor: typeof raw.corruptDocumentHashFor === "string" ? raw.corruptDocumentHashFor : undefined,
  };
}

export interface ProviderCallOutcome<T> {
  value?: T;
  ok: boolean;
  errorCategory: IntegrationErrorCategory | null;
  errorDetail: string | null;
  attempts: number;
  latencyMs: number;
  circuitOpen: boolean;
}

export const integrationConnectionService = {
  resolveRuntimeConfig,

  /** Build the per-call context (credential resolved from the secret store in-memory). */
  async buildCallContext(connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null }): Promise<{ ctx: ProviderCallContext; provider: IntegrationProvider }> {
    const provider = getProviderOrThrow(connection.providerType);
    const credentialPayload = await integrationCredentialService.resolve(connection.connectionId);
    const config = resolveRuntimeConfig(connection.configJson);
    return {
      provider,
      ctx: {
        connectionId: connection.id,
        connectionRef: connection.connectionId,
        providerType: connection.providerType,
        providerMode: connection.providerMode,
        environment: connection.environment,
        config,
        credential: credentialPayload ? { ...credentialPayload } : null,
        callId: randomUUID(),
      },
    };
  },

  /**
   * Environment separation (spec §8/§70): a connection configured for
   * one environment can never silently act against another. All mock
   * providers are pinned to their simulated endpoint; PRODUCTION mode
   * requires explicit confirmation at configure time (enforced in the
   * route/service create/update paths). The guard here refuses
   * provider calls from mismatched or unconfirmed production rows.
   */
  assertEnvironmentSafety(connection: { providerMode: string; environment: string; configJson: string | null }): void {
    if (connection.providerMode === "REAL" && connection.environment === "PRODUCTION") {
      const cfg = parseConnectionConfig(connection.configJson);
      if (cfg.productionConfirmed !== true) {
        throw new ApiError(422, "PRODUCTION_NOT_CONFIRMED", "Production integrations require explicit configuration and confirmation.");
      }
    }
    if (connection.providerMode === "MOCK" && connection.environment === "PRODUCTION") {
      throw new ApiError(422, "ENVIRONMENT_MODE_CONFLICT", "A MOCK provider cannot be configured as PRODUCTION.");
    }
  },

  /**
   * The ONLY path for invoking a provider operation: bounded,
   * classified, retried, circuit-broken, logged. Never throws for
   * provider-side failures — outcomes are returned as data (§59).
   */
  async runProviderCall<T>(
    connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null },
    operation: string,
    fn: (provider: IntegrationProvider, ctx: ProviderCallContext) => Promise<T>
  ): Promise<ProviderCallOutcome<T>> {
    const { provider, ctx } = await this.buildCallContext(connection);
    const breaker = getCircuitBreaker(connection.id, {
      failureThreshold: ctx.config.circuitFailureThreshold,
      cooldownMs: ctx.config.circuitCooldownMs,
    });

    const started = Date.now();
    let attempts = 1;
    let circuitOpen = false;

    try {
      const outcome = await breaker.execute(async () => {
        const retry = await executeWithRetry(() => fn(provider, ctx), {
          maxRetries: ctx.config.maxRetries,
          baseBackoffMs: ctx.config.baseBackoffMs,
        });
        attempts = retry.attempts;
        return retry.value;
      });
      const latencyMs = Date.now() - started;
      await this.logCall(connection, operation, "SUCCESS", latencyMs, null, 0);
      return { value: outcome, ok: true, errorCategory: null, errorDetail: null, attempts, latencyMs, circuitOpen: false };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const category: IntegrationErrorCategory =
        err instanceof CircuitOpenError
          ? "CIRCUIT_OPEN"
          : err instanceof ProviderError
            ? err.category
            : isRetryableError(err)
              ? "NETWORK"
              : "PROVIDER_ERROR";
      circuitOpen = err instanceof CircuitOpenError;
      const detail = err instanceof Error ? err.message.slice(0, 300) : "Provider call failed.";
      // retryAttempts is attached by executeWithRetry on exhaustion.
      const rawAttempts = (err as { retryAttempts?: number }).retryAttempts;
      const retryAttempts = typeof rawAttempts === "number" ? rawAttempts : 0;
      if (!circuitOpen) await this.logCall(connection, operation, "FAILURE", latencyMs, category, retryAttempts);
      return { ok: false, errorCategory: category, errorDetail: detail, attempts, latencyMs, circuitOpen };
    }
  },

  async logCall(
    connection: { id: string; connectionId: string; providerType: string },
    operation: string,
    outcome: "SUCCESS" | "FAILURE",
    latencyMs: number,
    errorCategory: IntegrationErrorCategory | null,
    retryCount: number
  ): Promise<void> {
    await db.integrationCallLog
      .create({
        data: {
          connectionId: connection.id,
          providerType: connection.providerType,
          operation,
          outcome,
          latencyMs,
          errorCategory,
          retryCount,
        },
      })
      .catch(() => undefined);

    await db.integrationConnection
      .update({
        where: { id: connection.id },
        data:
          outcome === "SUCCESS"
            ? { lastSuccessAt: new Date(), consecutiveFailures: 0 }
            : { lastFailureAt: new Date(), lastErrorCategory: errorCategory, consecutiveFailures: { increment: 1 } },
      })
      .catch(() => undefined);

    // Circuit-open is an operational alarm worth a chained audit event.
    if (errorCategory === "CIRCUIT_OPEN") {
      await recordAuditEvent({
        eventType: "INTEGRATION_CIRCUIT_OPENED",
        actorOfficerId: null,
        metadata: { connectionId: connection.connectionId, providerType: connection.providerType, operation },
      }).catch(() => undefined);
    }
  },

  /** §9/§10 — connection test: network + authentication + capability probe. */
  async testConnection(ctx: AuthContext, connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null; status: string }): Promise<{ outcome: "SUCCESS" | "FAILED" | "NOT_CONFIGURED" | "UNSUPPORTED"; detail: Record<string, unknown> }> {
    assertIntegrationPermission(ctx, "integration.test" as Permission);
    await assertConnectionAccess(ctx, connection as never, "integration.test" as Permission, "test");
    this.assertEnvironmentSafety(connection as never);

    const provider = getProviderOrThrow(connection.providerType);
    const { ctx: callCtx } = await this.buildCallContext(connection);

    const health = await this.runProviderCall(connection as never, "health_check", (p, c) => p.healthCheck(c));
    if (!health.ok) {
      await db.integrationConnection
        .update({ where: { id: connection.id }, data: { status: "ERROR", lastHealthCheckAt: new Date(), lastHealthStatus: "ERROR", lastHealthLatencyMs: health.latencyMs } })
        .catch(() => undefined);
      await recordAuditEvent({
        eventType: "INTEGRATION_CONNECTION_TESTED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { connectionId: connection.connectionId, providerType: connection.providerType, errorCategory: health.errorCategory },
      });
      return { outcome: "FAILED", detail: { errorCategory: health.errorCategory, errorDetail: health.errorDetail } };
    }

    const auth = await this.runProviderCall(connection as never, "authenticate", (p, c) => p.authenticate(c));
    const authResult = auth.value;
    if (!auth.ok || !authResult?.ok) {
      // Authentication failures are terminal (never retried) — record the
      // call as an explicit AUTH_FAILED failure for metrics/health (§66/§67).
      await this.logCall(connection, "authenticate", "FAILURE", auth.latencyMs, "AUTH_FAILED", 0);
      await db.integrationConnection.update({ where: { id: connection.id }, data: { status: "ERROR", lastHealthCheckAt: new Date(), lastHealthStatus: "ERROR" } }).catch(() => undefined);
      await recordAuditEvent({
        eventType: "INTEGRATION_AUTHENTICATION_FAILED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { connectionId: connection.connectionId, providerType: connection.providerType, errorCategory: auth.ok ? authResult?.errorCategory ?? null : auth.errorCategory },
      });
      const category = auth.ok ? authResult?.errorCategory ?? null : auth.errorCategory;
      return { outcome: category === "AUTH_FAILED" ? "NOT_CONFIGURED" : "FAILED", detail: { errorCategory: category, errorDetail: auth.ok ? authResult?.detail ?? null : auth.errorDetail } };
    }

    const capabilities = provider.capabilities;
    await db.integrationConnection
      .update({
        where: { id: connection.id },
        data: {
          status: "CONNECTED",
          lastHealthCheckAt: new Date(),
          lastHealthStatus: "CONNECTED",
          lastHealthLatencyMs: health.latencyMs,
          capabilitiesSnapshot: JSON.stringify(capabilities),
        },
      })
      .catch(() => undefined);

    await recordAuditEvent({
      eventType: "INTEGRATION_CONNECTION_TESTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "SUCCESS",
      metadata: { connectionId: connection.connectionId, providerType: connection.providerType, latencyMs: health.latencyMs },
    });

    return {
      outcome: "SUCCESS",
      detail: {
        latencyMs: health.latencyMs,
        providerMode: connection.providerMode,
        environment: connection.environment,
        capabilities,
        detail: health.value?.detail ?? null,
      },
    };
  },

  /** §9 — provider health report. */
  async healthCheckConnection(ctx: AuthContext | null, connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null; status: string; enabled: boolean; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastErrorCategory: string | null }) {
    if (!connection.enabled) {
      return { provider: connection.providerType, connectionId: connection.connectionId, environment: connection.environment, status: "DISABLED", latencyMs: null, lastSuccess: connection.lastSuccessAt, lastFailure: connection.lastFailureAt, errorCategory: null, circuitState: peekCircuitState(connection.id) };
    }
    const health = await this.runProviderCall(connection as never, "health_check", (p, c) => p.healthCheck(c));
    const status = health.ok ? "CONNECTED" : "ERROR";
    await db.integrationConnection
      .update({
        where: { id: connection.id },
        data: { lastHealthCheckAt: new Date(), lastHealthStatus: status, lastHealthLatencyMs: health.latencyMs, ...(health.ok ? {} : { lastErrorCategory: health.errorCategory }) },
      })
      .catch(() => undefined);
    await recordAuditEvent({
      eventType: "INTEGRATION_HEALTH_CHECKED",
      actorOfficerId: ctx?.officer.id ?? null,
      metadata: { connectionId: connection.connectionId, providerType: connection.providerType, status, latencyMs: health.latencyMs, errorCategory: health.errorCategory },
    }).catch(() => undefined);
    return {
      provider: connection.providerType,
      connectionId: connection.connectionId,
      environment: connection.environment,
      status,
      latencyMs: health.latencyMs,
      lastSuccess: connection.lastSuccessAt,
      lastFailure: connection.lastFailureAt,
      errorCategory: health.ok ? null : health.errorCategory,
      circuitState: peekCircuitState(connection.id),
    };
  },
};
