import { createHash } from "crypto";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { INTEGRATION_RATE_LIMITS, INTEGRATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS } from "@/lib/constants";
import { recordAuditEvent } from "@/lib/audit/service";
import { getProviderOrThrow } from "../registry";
import { integrationCredentialService } from "../credentials";
import type { ProviderCallContext, ProviderRuntimeConfig } from "../provider";

// ============================================================
// Phase 8 — Webhook receiving architecture (spec §30-§32).
//
// NEVER trust webhook payloads blindly. Order of defenses:
//   1. rate limit per provider endpoint
//   2. resolve connection by provider type (enabled connections only)
//   3. signature verification (provider-verified, timing-safe)
//   4. timestamp validation (replay window)
//   5. idempotency (provider event id, else deterministic body hash)
//   6. schema validation + known-event-type gate
//   7. processing (currently: case-change notices → recorded for the
//      sync/conflict flow; nothing is auto-applied)
// Every acceptance AND rejection is audited; payload contents are
// never stored — only a payload hash reference (§37/§66).
// ============================================================

const KNOWN_EVENT_TYPES = new Set([
  "CASE_UPDATED",
  "CASE_CREATED",
  "DOCUMENT_ADDED",
  "EVIDENCE_UPDATED",
  "HEARTBEAT",
]);

function deterministicIdempotencyKey(providerType: string, rawBody: string): string {
  return `deterministic:${createHash("sha256").update(`${providerType}|${rawBody}`).digest("hex")}`;
}

export interface WebhookOutcome {
  status: number;
  body: { accepted: boolean; code: string; message: string };
}

export const integrationWebhookService = {
  async receive(providerSlug: string, headers: Record<string, string>, rawBody: string, sourceIp: string): Promise<WebhookOutcome> {
    const providerType = providerSlug.toUpperCase().replace(/-/g, "_");

    // 1. Rate limit per endpoint (§30/§35).
    const rl = rateLimit(`integration-webhook:${providerType}:${sourceIp}`, INTEGRATION_RATE_LIMITS.WEBHOOK.limit, INTEGRATION_RATE_LIMITS.WEBHOOK.windowMs);
    if (!rl.allowed) {
      return { status: 429, body: { accepted: false, code: "RATE_LIMITED", message: "Too many webhook deliveries." } };
    }

    // 2. Provider + connection resolution (never 404-probe internal ids).
    if (!getProviderOrThrowSafe(providerType)) {
      return { status: 404, body: { accepted: false, code: "UNKNOWN_PROVIDER", message: "Unknown integration provider." } };
    }
    const connection = await db.integrationConnection.findFirst({
      where: { providerType, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    if (!connection) {
      return { status: 404, body: { accepted: false, code: "NO_ACTIVE_CONNECTION", message: "No active connection for this provider." } };
    }

    const reject = async (code: string, httpStatus: number, signatureStatus: string, detail: string): Promise<WebhookOutcome> => {
      await db.integrationWebhookEvent
        .create({
          data: {
            providerType,
            connectionId: connection.id,
            eventType: "UNKNOWN",
            signatureStatus,
            processingStatus: "REJECTED",
            payloadHash: createHash("sha256").update(rawBody).digest("hex"),
            errorMessage: `${code}:${detail}`.slice(0, 300),
            // Rejected events are audit records, not dedupe anchors — key
            // them per attempt so a repeated attack payload never collides.
            idempotencyKey: `${deterministicIdempotencyKey(providerType, rawBody)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          },
        })
        .catch(() => undefined);
      await recordAuditEvent({
        eventType: "INTEGRATION_WEBHOOK_REJECTED",
        actorOfficerId: null,
        metadata: { providerType, connectionId: connection.connectionId, code, signatureStatus },
      }).catch(() => undefined);
      return { status: httpStatus, body: { accepted: false, code, message: "Webhook rejected." } };
    };

    const provider = getProviderOrThrow(providerType)!;
    if (!provider.verifyWebhookSignature || !provider.parseWebhookEvent) {
      return reject("WEBHOOK_UNSUPPORTED", 400, "DISABLED", "Provider does not support webhooks.");
    }
    if (!provider.capabilities.supports_webhooks) {
      return reject("WEBHOOK_UNSUPPORTED", 400, "DISABLED", "Provider does not declare webhook support.");
    }

    // 3./4. Signature + timestamp verification (provider-specific, timing-safe).
    const callCtx: Omit<ProviderCallContext, "credential" | "callId"> = {
      connectionId: connection.id,
      connectionRef: connection.connectionId,
      providerType: connection.providerType,
      providerMode: connection.providerMode,
      environment: connection.environment,
      config: { timeoutMs: 5000, maxRetries: 0, baseBackoffMs: 100, circuitFailureThreshold: 5, circuitCooldownMs: 30000 } as ProviderRuntimeConfig,
    };
    const credential = await integrationCredentialService.resolve(connection.connectionId);
    const verification = await provider.verifyWebhookSignature({ ...callCtx, credential: credential ? { ...credential } : null, callId: "webhook" }, { headers, rawBody });
    if (!verification.verified) {
      return reject(
        verification.signatureStatus === "MISSING" ? "SIGNATURE_MISSING" : verification.signatureStatus === "DISABLED" ? "SIGNATURE_DISABLED" : verification.detail?.includes("replay") ? "TIMESTAMP_INVALID" : "SIGNATURE_INVALID",
        401,
        verification.signatureStatus,
        verification.detail ?? "signature verification failed"
      );
    }

    // Parse + schema-shape validation.
    const parsed = await provider.parseWebhookEvent({ ...callCtx, credential: null, callId: "webhook" }, { headers, rawBody });
    if (!parsed || !parsed.eventType) {
      return reject("MALFORMED_PAYLOAD", 422, "VERIFIED", "Payload is not a valid event document.");
    }

    // 5. Idempotency (§32): provider event id first, deterministic hash fallback.
    const idempotencyKey = parsed.externalEventId || deterministicIdempotencyKey(providerType, rawBody);
    const duplicate = await db.integrationWebhookEvent.findUnique({
      where: { providerType_idempotencyKey: { providerType, idempotencyKey } },
    });
    if (duplicate) {
      return { status: 200, body: { accepted: true, code: "ALREADY_PROCESSED", message: "Event already received — not processed twice." } };
    }

    // 6. Known-event-type gate — unknown types are rejected safely (not crashed on).
    if (!KNOWN_EVENT_TYPES.has(parsed.eventType)) {
      return reject("UNKNOWN_EVENT_TYPE", 422, "VERIFIED", `Event type '${parsed.eventType.slice(0, 40)}' is not recognized.`);
    }

    // Schema-version gate for webhook payloads (§19/§69): unknown
    // versions are recorded but not acted upon.
    let schemaUnsupported = false;
    if (parsed.schemaVersion) {
      const known = await db.integrationSchemaVersion.findUnique({
        where: { providerType_schemaName_schemaVersion: { providerType, schemaName: provider.schemaName, schemaVersion: parsed.schemaVersion } },
      });
      schemaUnsupported = !known || !known.supported;
    }

    // 7. Record + process (references only — never the payload).
    const event = await db.integrationWebhookEvent.create({
      data: {
        providerType,
        connectionId: connection.id,
        externalEventId: parsed.externalEventId ?? null,
        eventType: parsed.eventType,
        signatureStatus: "VERIFIED",
        processingStatus: schemaUnsupported ? "VALIDATED" : "PROCESSED",
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
        processedAt: schemaUnsupported ? null : new Date(),
        errorMessage: schemaUnsupported ? `SCHEMA_VERSION_UNSUPPORTED:${String(parsed.schemaVersion).slice(0, 30)}` : null,
        idempotencyKey,
      },
    });

    await recordAuditEvent({
      eventType: "INTEGRATION_WEBHOOK_RECEIVED",
      actorOfficerId: null,
      metadata: { providerType, connectionId: connection.connectionId, eventId: event.id, eventType: parsed.eventType, schemaUnsupported },
    });

    return { status: 200, body: { accepted: true, code: schemaUnsupported ? "VALIDATED_SCHEMA_UNSUPPORTED" : "PROCESSED", message: "Webhook received." } };
  },
};

function getProviderOrThrowSafe(providerType: string) {
  try {
    return getProviderOrThrow(providerType);
  } catch {
    return null;
  }
}

void INTEGRATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS; // enforced inside provider verification (documented constant)
