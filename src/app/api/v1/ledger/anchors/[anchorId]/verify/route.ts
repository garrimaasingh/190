import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { verifyAnchor } from "@/lib/audit/ledger";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/ledger/anchors/{anchorId}/verify — verify that the
// chain still reproduces an anchor's committed hash (spec §30
// verify_anchor). Auditor-accessible (read-level operation).
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ anchorId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.AUDIT_READ);
    const { anchorId } = await params;
    const result = await verifyAnchor(ctx, anchorId);
    return jsonOk(result);
  } catch (err) {
    return handleApiError(err);
  }
}
