import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loadCaseGraph } from "@/lib/graph/graph-read";

export const runtime = "nodejs";

// GET /api/v1/graph/cases/{caseId} — case knowledge graph (Phase 6,
// spec §67). Authorization is layered server-side: graph.read
// permission → case-level access → per-node classification
// clearance (nodes above clearance are dropped, not masked).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.GRAPH_READ);
    const { caseId } = await params;
    const payload = await loadCaseGraph(ctx, caseId);
    return jsonOk(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
