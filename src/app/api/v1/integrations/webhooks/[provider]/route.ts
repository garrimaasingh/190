import { integrationWebhookService } from "@/lib/integrations/services/webhook-service";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/integrations/webhooks/[provider] — provider webhook
// receiver (spec §30). The spec path /integrations/{provider}/webhook
// is adapted to /integrations/webhooks/{provider} because Next.js
// does not allow two differently-named dynamic segments at the same
// route level ([connectionId] and [provider] would collide).
//
// Defense order (inside the service): rate limit → provider/
// connection resolution → signature verification (timing-safe) →
// timestamp/replay window → idempotency → schema/event gate →
// audited processing. Never trusts the payload blindly.
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const rawBody = await req.text(); // raw body REQUIRED for signature verification
  const headers = Object.fromEntries([...req.headers.entries()]);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "127.0.0.1";
  const outcome = await integrationWebhookService.receive(provider, headers, rawBody, ip);
  return Response.json(outcome.body, { status: outcome.status, headers: { "Cache-Control": "no-store" } });
}
