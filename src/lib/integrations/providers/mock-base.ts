import { createHmac, timingSafeEqual } from "crypto";
import {
  emptyCapabilities,
  ProviderError,
  type ExternalCasePayload,
  type ExternalCaseSearchQuery,
  type ExternalCaseSummary,
  type ExternalDocumentPayload,
  type ExternalEvidencePayload,
  type ExportCasePackage,
  type IntegrationCapabilities,
  type IntegrationProvider,
  type ParsedWebhookEvent,
  type ProviderAck,
  type ProviderAuthResult,
  type ProviderCallContext,
  type ProviderHealthResult,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
} from "../provider";
import { getMockCase, listMockCases } from "../data";

// ============================================================
// Phase 8 — MockIntegrationProvider (spec §50).
//
// A realistic in-platform simulator of an external departmental
// system. It supports: case search / retrieval / document & evidence
// retrieval / case export / webhook (signed) / FAILURE simulation /
// RATE-LIMIT simulation / SCHEMA-VERSION simulation.
//
// EVERYTHING here is a simulation. No network calls are made. The
// class exists so the complete integration workflow can be built,
// demonstrated and tested without government credentials (§1).
// ============================================================

/** Per-connection simulation state (rate-limit windows, failure counters). */
interface SimState {
  windowStartMs: number;
  windowCount: number;
}

// globalThis singleton: bundlers may duplicate module state per route
// bundle; simulation state must be ONE per connection platform-wide.
interface SimStateGlobal {
  __mockSimState?: Map<string, SimState>;
}
const simState: Map<string, SimState> =
  (globalThis as unknown as SimStateGlobal).__mockSimState ??
  ((globalThis as unknown as SimStateGlobal).__mockSimState = new Map());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export abstract class MockIntegrationProvider implements IntegrationProvider {
  abstract readonly providerType: string;
  abstract readonly capabilities: IntegrationCapabilities;
  readonly providerMode = "MOCK" as const;
  readonly schemaName = "case_exchange";
  readonly supportedSchemaVersions = ["1.0"] as string[];
  readonly minPollingIntervalMinutes = 5;
  /** Human-readable simulated endpoint — never a real government URL. */
  readonly simulatedEndpoint: string;

  constructor(simulatedEndpoint: string) {
    this.simulatedEndpoint = simulatedEndpoint;
  }

  // ------------------------------------------------------------
  // Simulation plumbing
  // ------------------------------------------------------------

  /** Shared pre-call simulation: latency, failure, rate limit. */
  protected async simulate(ctx: ProviderCallContext): Promise<void> {
    const cfg = ctx.config;
    if (cfg.latencyMs && cfg.latencyMs > 0) {
      await sleep(Math.min(cfg.latencyMs, 2000));
    }
    if (cfg.failNext && cfg.failNext > 0) {
      cfg.failNext -= 1;
      throw new ProviderError("SERVER_ERROR", "MOCK: simulated provider outage (failNext)", { httpStatus: 503 });
    }
    if (cfg.rateLimitPerMinute && cfg.rateLimitPerMinute > 0) {
      const now = Date.now();
      let st = simState.get(ctx.connectionId);
      if (!st || now - st.windowStartMs > 60_000) {
        st = { windowStartMs: now, windowCount: 0 };
        simState.set(ctx.connectionId, st);
      }
      st.windowCount += 1;
      if (st.windowCount > cfg.rateLimitPerMinute) {
        const retryAfter = Math.max(1, Math.ceil((st.windowStartMs + 60_000 - now) / 1000));
        throw new ProviderError("RATE_LIMITED", "MOCK: simulated provider rate limit exceeded", {
          retryAfterSeconds: retryAfter,
          httpStatus: 429,
        });
      }
    }
  }

  /** Payload schema version (scenario override can simulate change, §69). */
  protected schemaVersion(ctx: ProviderCallContext): string {
    return ctx.config.scenarioSchemaVersion || "1.0";
  }

  protected requireAuth(ctx: ProviderCallContext): void {
    if (ctx.config && (ctx.config as { requireAuthForMock?: boolean }).requireAuthForMock === false) return;
    // MOCK auth: an API key credential must exist and be well-formed.
    if (!ctx.credential?.apiKey || ctx.credential.apiKey.length < 8) {
      throw new ProviderError("AUTH_FAILED", "MOCK: missing or malformed API key credential", { httpStatus: 401 });
    }
  }

  // ------------------------------------------------------------
  // IntegrationProvider — always-supported core operations
  // ------------------------------------------------------------

  async connect(ctx: ProviderCallContext): Promise<ProviderHealthResult> {
    const started = Date.now();
    await this.simulate(ctx);
    return { ok: true, latencyMs: Date.now() - started, detail: `MOCK endpoint ${this.simulatedEndpoint} reachable (simulated)` };
  }

  async authenticate(ctx: ProviderCallContext): Promise<ProviderAuthResult> {
    const started = Date.now();
    try {
      await this.simulate(ctx);
      this.requireAuth(ctx);
      return { ok: true, detail: "MOCK API key accepted (simulated)" };
    } catch (err) {
      if (err instanceof ProviderError && err.category === "AUTH_FAILED") {
        return { ok: false, errorCategory: "AUTH_FAILED", detail: err.message };
      }
      throw err;
    } finally {
      void started;
    }
  }

  async healthCheck(ctx: ProviderCallContext): Promise<ProviderHealthResult> {
    const started = Date.now();
    await this.simulate(ctx);
    return { ok: true, latencyMs: Date.now() - started, detail: "MOCK healthy (simulated)" };
  }

  async disconnect(_ctx: ProviderCallContext): Promise<void> {
    // Stateless mock — nothing to release.
  }

  // ------------------------------------------------------------
  // Capability-gated data operations (mock implementations)
  // ------------------------------------------------------------

  async searchCases(ctx: ProviderCallContext, query: ExternalCaseSearchQuery): Promise<{ items: ExternalCaseSummary[]; total: number; nextCursor: string | null }> {
    await this.simulate(ctx);
    this.requireAuth(ctx);
    const schema = this.schemaVersion(ctx);
    let items = listMockCases();
    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.externalCaseId.toLowerCase().includes(q) ||
          c.externalCaseNumber.toLowerCase().includes(q)
      );
    }
    if (query.updatedSince) {
      const since = new Date(query.updatedSince).getTime();
      items = items.filter((c) => new Date(c.updatedAt).getTime() > since);
    }
    const total = items.length;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
    const paged = items.slice((page - 1) * pageSize, page * pageSize);
    const summaries: ExternalCaseSummary[] = paged.map((c) => ({
      externalCaseId: c.externalCaseId,
      externalCaseNumber: c.externalCaseNumber,
      title: c.title,
      caseType: c.caseType,
      status: c.status,
      updatedAt: c.updatedAt,
      schemaVersion: schema,
    }));
    const nextCursor = page * pageSize < total ? String(page + 1) : null;
    return { items: summaries, total, nextCursor };
  }

  async getCase(ctx: ProviderCallContext, externalCaseId: string): Promise<ExternalCasePayload> {
    await this.simulate(ctx);
    this.requireAuth(ctx);
    const c = getMockCase(externalCaseId);
    if (!c) throw new ProviderError("NOT_FOUND", `MOCK: external case ${externalCaseId} not found`, { httpStatus: 404 });
    return {
      externalCaseId: c.externalCaseId,
      externalCaseNumber: c.externalCaseNumber,
      caseNumber: c.externalCaseNumber,
      title: c.title,
      description: c.description,
      caseType: c.caseType,
      priority: c.priority,
      status: c.status,
      district: c.district,
      state: c.state,
      investigatingOfficer: c.investigatingOfficer,
      updatedAt: c.updatedAt,
      schemaVersion: this.schemaVersion(ctx),
      documents: c.documents.map((d) => ({ ...d, contentBase64: null })), // content fetched explicitly (§64)
      evidence: c.evidence.map((e) => ({ ...e })),
    };
  }

  async getDocumentContent(ctx: ProviderCallContext, _externalCaseId: string, externalDocumentId: string): Promise<ExternalDocumentPayload> {
    await this.simulate(ctx);
    this.requireAuth(ctx);
    for (const c of listMockCases()) {
      const d = c.documents.find((x) => x.externalDocumentId === externalDocumentId);
      if (d) {
        const payload = { ...d };
        // §55 test scenario: simulate an external system reporting a WRONG
        // integrity hash — the platform must BLOCK the import.
        if ((ctx.config as { corruptDocumentHashFor?: string }).corruptDocumentHashFor === externalDocumentId) {
          payload.sourceHash = "f".repeat(8) + payload.sourceHash.slice(8);
        }
        return payload;
      }
    }
    throw new ProviderError("NOT_FOUND", `MOCK: external document ${externalDocumentId} not found`, { httpStatus: 404 });
  }

  async getEvidence(ctx: ProviderCallContext, externalCaseId: string): Promise<ExternalEvidencePayload[]> {
    await this.simulate(ctx);
    this.requireAuth(ctx);
    const c = getMockCase(externalCaseId);
    if (!c) throw new ProviderError("NOT_FOUND", `MOCK: external case ${externalCaseId} not found`, { httpStatus: 404 });
    return c.evidence.map((e) => ({ ...e }));
  }

  async exportCase(ctx: ProviderCallContext, pkg: ExportCasePackage): Promise<ProviderAck> {
    await this.simulate(ctx);
    this.requireAuth(ctx);
    return {
      accepted: true,
      externalReference: `${this.providerType}-ACK-${pkg.exportJobId}`,
      acknowledgedAt: new Date().toISOString(),
      message: `MOCK: ${pkg.documents.length} document(s), ${pkg.evidence.length} evidence item(s) acknowledged by ${this.simulatedEndpoint}`,
    };
  }

  // ------------------------------------------------------------
  // Webhook simulation (spec §30-§32): HMAC-SHA256 over the raw body
  // + separate timestamp header, mirroring common signed-webhook
  // schemes. Signature verification uses timing-safe comparison.
  // ------------------------------------------------------------

  static readonly WEBHOOK_SIGNATURE_HEADER = "x-mock-signature";
  static readonly WEBHOOK_TIMESTAMP_HEADER = "x-mock-timestamp";

  /** Helper used by tests/demo to CRAFT a valid signed webhook payload. */
  static craftSignedWebhook(webhookSecret: string, event: Record<string, unknown>, opts?: { timestampMs?: number }): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(event);
    const timestampMs = opts?.timestampMs ?? Date.now();
    const signature = createHmac("sha256", webhookSecret).update(`${timestampMs}.${rawBody}`).digest("hex");
    return {
      headers: {
        "x-mock-signature": signature,
        "x-mock-timestamp": String(timestampMs),
      },
      rawBody,
    };
  }

  async verifyWebhookSignature(ctx: ProviderCallContext, input: WebhookVerificationInput): Promise<WebhookVerificationResult> {
    const secret = ctx.credential?.webhookSecret;
    if (!secret) {
      return { verified: false, signatureStatus: "DISABLED", errorCategory: "VALIDATION", detail: "No webhook secret configured for this connection." };
    }
    const signature = input.headers[MockIntegrationProvider.WEBHOOK_SIGNATURE_HEADER];
    const timestamp = input.headers[MockIntegrationProvider.WEBHOOK_TIMESTAMP_HEADER];
    if (!signature || !timestamp) {
      return { verified: false, signatureStatus: "MISSING", errorCategory: "VALIDATION", detail: "Missing signature or timestamp header." };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { verified: false, signatureStatus: "INVALID", errorCategory: "VALIDATION", detail: "Malformed timestamp." };
    }
    // Replay protection: reject timestamps outside the tolerance window (§30).
    const tolerance = 5 * 60 * 1000;
    if (Math.abs(Date.now() - ts) > tolerance) {
      return { verified: false, signatureStatus: "INVALID", errorCategory: "VALIDATION", detail: "Timestamp outside tolerance window (possible replay)." };
    }
    const expected = createHmac("sha256", secret).update(`${ts}.${input.rawBody}`).digest("hex");
    const actual = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
      return { verified: false, signatureStatus: "INVALID", errorCategory: "VALIDATION", detail: "Signature verification failed." };
    }
    return { verified: true, signatureStatus: "VERIFIED" };
  }

  async parseWebhookEvent(_ctx: ProviderCallContext, input: WebhookVerificationInput): Promise<ParsedWebhookEvent | null> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      return null; // malformed payload — caller rejects safely
    }
    const eventType = typeof parsed.event_type === "string" ? parsed.event_type : "";
    if (!eventType) return null;
    return {
      externalEventId: typeof parsed.event_id === "string" ? parsed.event_id : null,
      eventType,
      occurredAt: typeof parsed.occurred_at === "string" ? parsed.occurred_at : null,
      schemaVersion: typeof parsed.schema_version === "string" ? parsed.schema_version : null,
      payload: parsed,
    };
  }

  protected static baseCapabilities(): IntegrationCapabilities {
    return emptyCapabilities();
  }
}
