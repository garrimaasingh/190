// Phase 9 — test rate-limit bypass (same mechanism as Phase 8:
// shared TEST_RATELIMIT_BYPASS_KEY, exercised only by the suites).
export function interopRateLimitBypass(req: Request): boolean {
  const key = process.env.TEST_RATELIMIT_BYPASS_KEY;
  return !!key && req.headers.get("x-test-bypass-rate-limit") === key;
}
