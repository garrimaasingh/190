import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getIncomingTransfers } from "@/lib/cases/custody";

export const runtime = "nodejs";

// GET /api/v1/transfers/incoming — pending custody transfers for the
// authenticated officer's department (the "incoming transfer mailbox",
// spec §21/§49). The destination department is derived from the session.
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.CASE_READ);
    const items = await getIncomingTransfers(ctx);
    return jsonOk({ items, total: items.length });
  } catch (err) {
    return handleApiError(err);
  }
}
