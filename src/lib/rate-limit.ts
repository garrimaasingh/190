// ============================================================
// In-memory sliding-window rate limiter (spec §46).
// Appropriate for the single-node Phase 1 deployment; a
// distributed store can replace the Map later without
// changing the call sites.
// ============================================================

interface Window {
  hits: number[];
}

const buckets = new Map<string, Window>();
let lastSweep = Date.now();

function sweep(now: number, maxAgeMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, win] of buckets) {
    win.hits = win.hits.filter((t) => now - t < maxAgeMs);
    if (win.hits.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);
  const win = buckets.get(key) || { hits: [] };
  win.hits = win.hits.filter((t) => now - t < windowMs);
  if (win.hits.length >= limit) {
    buckets.set(key, win);
    const oldest = win.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  win.hits.push(now);
  buckets.set(key, win);
  return { allowed: true, remaining: limit - win.hits.length, retryAfterSeconds: 0 };
}
