import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationConnectionService } from "@/lib/integrations/services/connection-service";
import { assertConnectionAccess } from "@/lib/integrations/authorization";
import { peekCircuitState } from "@/lib/integrations/circuit-breaker";

export const runtime = "nodejs";

// GET /api/v1/integrations/[connectionId]/health — per-connection health (§9).
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { connectionId } = await params;
    const connection = await db.integrationConnection.findUnique({ where: { connectionId } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, PERMISSIONS.INTEGRATION_READ, "read");
    const report = await integrationConnectionService.healthCheckConnection(ctx, connection);
    return jsonOk({ ...report, circuitState: peekCircuitState(connection.id) });
  } catch (err) {
    return handleApiError(err);
  }
}
