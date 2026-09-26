import { ProviderError } from "./provider";
import { INTEGRATION_RETRYABLE_CATEGORIES } from "@/lib/constants";

// ============================================================
// Phase 8 — Retry policy (spec §67/§68).
//
// RETRY ONLY transient errors: timeouts, network failures, 5xx,
// provider rate limits. NEVER blindly retry authentication
// failures, validation failures, authorization failures or schema
// failures — retrying those just hammers the provider with
// requests that cannot succeed.
//
// Backoff: exponential with FULL JITTER (AWS-recommended), capped,
// honoring provider retry-after hints. Max retry count is hard —
// no retry storms (§35).
// ============================================================

export interface RetryOptions {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each failed attempt for observability. */
  onRetry?: (info: { attempt: number; category: string; delayMs: number; retryAfterSeconds?: number }) => void;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number; // total attempts INCLUDING the successful one
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return INTEGRATION_RETRYABLE_CATEGORIES.includes(err.category);
  }
  // Unknown errors (raw network stacks) are treated as transient
  // network-class failures — the conservative retryable default for
  // infrastructure noise, distinct from provider-classified errors.
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(msg);
}

function fullJitter(baseMs: number, attempt: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exponential);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute an operation with classified retry + exponential backoff
 * with jitter. Non-retryable failures throw immediately.
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<RetryOutcome<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const maxMs = options.maxBackoffMs ?? 10_000;
  let attempt = 0;
  // attempts loop: initial try + maxRetries retries
  for (;;) {
    try {
      const value = await operation();
      return { value, attempts: attempt + 1 };
    } catch (err) {
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= options.maxRetries) {
        // Non-retryable OR retry budget exhausted — surface as-is.
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          retryAttempts: attempt,
        });
      }
      const retryAfterSeconds =
        err instanceof ProviderError ? err.retryAfterSeconds : undefined;
      // Honor provider retry-after when present; otherwise full jitter.
      const delayMs =
        retryAfterSeconds !== undefined
          ? Math.min(maxMs, retryAfterSeconds * 1000)
          : fullJitter(options.baseBackoffMs, attempt, maxMs);
      options.onRetry?.({
        attempt: attempt + 1,
        category: err instanceof ProviderError ? err.category : "NETWORK",
        delayMs,
        retryAfterSeconds,
      });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
