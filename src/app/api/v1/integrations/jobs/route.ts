import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { connectionVisibleTo } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// GET /api/v1/integrations/jobs — import + export job lists (§42).
// Scoped: department admins/officers see their department's
// connections' jobs; SYSTEM_ADMIN/AUDITOR see all (read-only for auditor).
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const providerType = url.searchParams.get("providerType") || undefined;

    const connections = await db.integrationConnection.findMany();
    const visibleIds = new Set(connections.filter((c) => connectionVisibleTo(ctx, c)).map((c) => c.id));

    const [imports, exports] = await Promise.all([
      db.integrationImportJob.findMany({
        where: { connectionId: { in: Array.from(visibleIds) }, ...(status ? { status } : {}), ...(providerType ? { providerType } : {}) },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { connection: { select: { connectionId: true, providerType: true, providerMode: true, displayName: true } }, requestedByOfficer: { select: { officerId: true, name: true } } },
      }),
      db.integrationExportJob.findMany({
        where: { connectionId: { in: Array.from(visibleIds) }, ...(status ? { status } : {}), ...(providerType ? { providerType } : {}) },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { connection: { select: { connectionId: true, providerType: true, providerMode: true, displayName: true } }, requestedByOfficer: { select: { officerId: true, name: true } } },
      }),
    ]);

    return jsonOk({ imports, exports });
  } catch (err) {
    return handleApiError(err);
  }
}

void ApiError;
