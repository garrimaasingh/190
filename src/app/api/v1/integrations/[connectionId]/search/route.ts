import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { integrationConnectionService } from "@/lib/integrations/services/connection-service";
import { assertConnectionAccess } from "@/lib/integrations/authorization";
import { getProviderOrThrow } from "@/lib/integrations/registry";

export const runtime = "nodejs";

// POST /api/v1/integrations/[connectionId]/search — external case
// search (capability-gated; demo §61 step 7). Returns external case
// SUMMARIES only — full payloads require an explicit import.
const searchSchema = z
  .object({ q: z.string().trim().max(120).optional(), page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(50).optional() })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { connectionId } = await params;
    const connection = await db_load(connectionId);
    // Search performs a LIVE provider call — gated like an operation
    // ("test"-class), not as passive read: disabled connections refuse it.
    await assertConnectionAccess(ctx, connection, PERMISSIONS.INTEGRATION_TEST, "test");
    const provider = getProviderOrThrow(connection.providerType);
    if (!provider.searchCases || !provider.capabilities.can_search_cases) {
      throw new ApiError(409, "CAPABILITY_NOT_SUPPORTED", "The provider does not support case search.");
    }
    const body = searchSchema.parse(await req.json().catch(() => ({})));
    const result = await integrationConnectionService.runProviderCall(connection, "search_cases", (p, c) => p.searchCases!(c, body));
    if (!result.ok || !result.value) throw new ApiError(502, "PROVIDER_ERROR", `Provider search failed (${result.errorCategory}).`);
    return jsonOk({ ...result.value, providerMode: connection.providerMode, environment: connection.environment });
  } catch (err) {
    return handleApiError(err);
  }
}

async function db_load(connectionId: string) {
  const { db } = await import("@/lib/db");
  const connection = await db.integrationConnection.findUnique({ where: { connectionId } });
  if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
  return connection;
}
