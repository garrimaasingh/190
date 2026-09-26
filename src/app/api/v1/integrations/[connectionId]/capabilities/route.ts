import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertConnectionAccess } from "@/lib/integrations/authorization";
import { getProviderOrThrow } from "@/lib/integrations/registry";
import type { IntegrationCapabilities } from "@/lib/integrations/provider";

export const runtime = "nodejs";

// GET /api/v1/integrations/[connectionId]/capabilities — capability model (§4).
// The UI and backend respect these flags: unsupported operations are
// not offered, not silently attempted.
const CAPABILITY_DESCRIPTIONS: Record<keyof IntegrationCapabilities, string> = {
  can_search_cases: "Search external case index",
  can_read_case: "Read external case details",
  can_import_case: "Import external case into the platform",
  can_export_case: "Export central case to the external system",
  can_read_documents: "List external case documents",
  can_import_documents: "Import external documents",
  can_export_documents: "Export central documents",
  can_read_evidence: "Read external evidence metadata",
  can_import_evidence: "Import external evidence",
  can_export_evidence: "Export central evidence",
  supports_webhooks: "Provider can push signed webhook events",
  supports_polling: "Provider supports polling synchronization",
  supports_batch_import: "Provider supports batch imports",
  supports_realtime: "Provider offers realtime exchange",
  supports_acknowledgement: "Provider returns acknowledgements for exports",
};

export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { connectionId } = await params;
    const connection = await db.integrationConnection.findUnique({ where: { connectionId } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, PERMISSIONS.INTEGRATION_READ, "read");
    const provider = getProviderOrThrow(connection.providerType);
    const detailed = Object.fromEntries(
      Object.entries(provider.capabilities).map(([k, v]) => [k, { enabled: v, description: CAPABILITY_DESCRIPTIONS[k as keyof IntegrationCapabilities] }])
    );
    return jsonOk({
      connectionId,
      providerType: connection.providerType,
      providerMode: connection.providerMode,
      capabilities: provider.capabilities,
      detailed,
      minPollingIntervalMinutes: provider.minPollingIntervalMinutes,
      supportedSchemaVersions: provider.supportedSchemaVersions,
      schemaName: provider.schemaName,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
