// ============================================================
// Phase 8 — Circuit breaker (spec §36).
//
// Repeated provider failures OPEN the circuit; further calls fail
// fast (CIRCUIT_OPEN) without touching the external system. After
// a cooldown the circuit goes HALF_OPEN and admits probe calls; a
// successful probe CLOSES it, a failure re-opens it.
//
// Integration failure MUST NOT make the main case system unusable:
// the breaker is per-connection, in-process, and the core platform
// has zero runtime dependency on it.
// ============================================================

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("CIRCUIT_OPEN");
    this.name = "CircuitOpenError";
  }
}

interface CircuitRuntime {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  halfOpenProbesInFlight: number;
}

export interface CircuitBreakerOptions {
  failureThreshold: number; // consecutive failures before OPEN
  cooldownMs: number; // OPEN → HALF_OPEN after this
}

export class CircuitBreaker {
  private rt: CircuitRuntime;
  private options!: CircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions) {
    this.options = options;
    this.rt = {
      state: "CLOSED",
      consecutiveFailures: 0,
      openedAtMs: null,
      halfOpenProbesInFlight: 0,
    };
  }

  get state(): CircuitState {
    this.advanceTime();
    return this.rt.state;
  }

  get consecutiveFailures(): number {
    return this.rt.consecutiveFailures;
  }

  /** Time until an OPEN circuit transitions to HALF_OPEN (0 when not open). */
  get retryAfterMs(): number {
    this.advanceTime();
    if (this.rt.state !== "OPEN" || this.rt.openedAtMs === null) return 0;
    return Math.max(0, this.options.cooldownMs - (Date.now() - this.rt.openedAtMs));
  }

  /**
   * Gate a call. Throws CircuitOpenError when OPEN (fail fast —
   * the external system is never touched).
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.advanceTime();
    if (this.rt.state === "OPEN") {
      throw new CircuitOpenError(this.retryAfterMs);
    }
    if (this.rt.state === "HALF_OPEN" && this.rt.halfOpenProbesInFlight > 0) {
      // One probe at a time while half-open.
      throw new CircuitOpenError(this.retryAfterMs);
    }
    if (this.rt.state === "HALF_OPEN") this.rt.halfOpenProbesInFlight += 1;
    try {
      const value = await operation();
      this.onSuccess();
      return value;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (this.rt.halfOpenProbesInFlight > 0) this.rt.halfOpenProbesInFlight -= 1;
    }
  }

  onSuccess(): void {
    this.rt.state = "CLOSED";
    this.rt.consecutiveFailures = 0;
    this.rt.openedAtMs = null;
  }

  /** Apply updated thresholds without resetting runtime state. */
  updateOptions(options: CircuitBreakerOptions): void {
    this.options = options;
    this.advanceTime();
  }

  onFailure(): void {
    if (this.rt.state === "HALF_OPEN") {
      // A failed probe immediately re-opens for a full cooldown.
      this.open();
      return;
    }
    this.rt.consecutiveFailures += 1;
    if (this.rt.consecutiveFailures >= this.options.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.rt.state = "OPEN";
    this.rt.openedAtMs = Date.now();
  }

  private advanceTime(): void {
    if (this.rt.state === "OPEN" && this.rt.openedAtMs !== null) {
      if (Date.now() - this.rt.openedAtMs >= this.options.cooldownMs) {
        this.rt.state = "HALF_OPEN";
        this.rt.halfOpenProbesInFlight = 0;
      }
    }
  }
}

// Per-connection breaker registry — keyed by internal connection id.
// globalThis singleton: bundlers may duplicate module state per route
// bundle; the circuit must be ONE per connection platform-wide.
interface BreakerGlobal {
  __integrationBreakers?: Map<string, CircuitBreaker>;
}
const breakers: Map<string, CircuitBreaker> =
  (globalThis as unknown as BreakerGlobal).__integrationBreakers ??
  ((globalThis as unknown as BreakerGlobal).__integrationBreakers = new Map());

export function getCircuitBreaker(connectionId: string, options: CircuitBreakerOptions): CircuitBreaker {
  let breaker = breakers.get(connectionId);
  if (!breaker) {
    breaker = new CircuitBreaker(options);
    breakers.set(connectionId, breaker);
  } else {
    // Runtime config may change (e.g. tests tightening the threshold) —
    // keep the existing state but apply the current options.
    breaker.updateOptions(options);
  }
  return breaker;
}

export function resetCircuitBreaker(connectionId: string): void {
  breakers.delete(connectionId);
}

/** Snapshot for the health endpoint (never mutates state). */
export function peekCircuitState(connectionId: string): CircuitState | null {
  const breaker = breakers.get(connectionId);
  return breaker ? breaker.state : null;
}
