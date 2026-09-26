import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { integrationConnectionService } from "@/lib/integrations/services/connection-service";
import { connectionVisibleTo } from "@/lib/integrations/authorization";
import { peekCircuitState } from "@/lib/integrations/circuit-breaker";

export const runtime = "nodejs";

// GET /api/v1/integrations/health — aggregate provider health (§9).
// Reports provider, environment, status, latency, last_success,
// last_failure, error_category. NEVER exposes credentials.
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const rows = await db.integrationConnection.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
    const visible = rows.filter((r) => connectionVisibleTo(ctx, r));
    const reports: Array<Record<string, unknown>> = [];
    for (const connection of visible) {
      const report = await integrationConnectionService.healthCheckConnection(ctx, connection);
      reports.push({ ...report, circuitState: peekCircuitState(connection.id) });
    }
    return jsonOk({
      checkedAt: new Date().toISOString(),
      providers: reports,
      summary: {
        total: reports.length,
        connected: reports.filter((r) => r.status === "CONNECTED").length,
        errors: reports.filter((r) => r.status === "ERROR").length,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
