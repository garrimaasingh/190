import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { resolveCaseAccess } from "@/lib/cases/access";
import { documentViewClearance } from "@/lib/documents/authorization";
import { recordAuditEvent } from "@/lib/audit/service";
import { filterGraphByClearance, type GraphEdgeDraft, type GraphNodeDraft } from "@/lib/graph/graph-build";
import { loadCaseForGraph, newestSourceTimestamp } from "@/lib/graph/graph-sync";

// ============================================================
// Phase 6 — CaseGraph read path (spec §67).
//
// Authorization is LAYERED, never trusted from the client:
//   1. role permission (graph.read) — route layer
//   2. case-level access (custodian / participation / assignment) —
//      resolveCaseAccess, same model as every case API
//   3. classification clearance — nodes whose supporting records
//      exceed the viewer's clearance are dropped ENTIRELY (no
//      label, no existence signal), and every edge touching a
//      dropped node is dropped with them.
//
// GRAPH_VIEWED is a read-path event (best-effort, availability
// choice); GRAPH_ACCESS_DENIED is awaited before the denial is
// returned (spec §48 policy, same as document access).
// ============================================================

export interface CaseGraphPayload {
  caseRef: string;
  graph: {
    nodes: (GraphNodeDraft & { id: string })[];
    edges: (Omit<GraphEdgeDraft, "sourceRefs"> & { id: string; sourceRefs: { model: string; id: string }[] })[];
  };
  sync: {
    status: string;
    nodeCount: number;
    edgeCount: number;
    syncVersion: number;
    lastSyncedAt: string | null;
    triggeredByOfficerId: string | null;
  } | null;
  staleness: {
    neverSynced: boolean;
    stale: boolean;
    newestSourceAt: string | null;
    lastSyncedAt: string | null;
  };
  viewer: {
    clearanceLevel: number;
    level: string;
    droppedNodes: number;
    droppedEdges: number;
    visibleNodes: number;
    visibleEdges: number;
  };
  disclaimer: string;
}

export async function loadCaseGraph(ctx: AuthContext, caseRef: string): Promise<CaseGraphPayload> {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.view) {
    await recordAuditEvent({
      eventType: "GRAPH_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      caseId: caseRow.caseId,
      result: "DENIED",
      metadata: { reason: "NO_CASE_ACCESS" },
    });
    throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
  }

  const publicCaseId = caseRow.caseId;
  const [state, newestSource] = await Promise.all([
    db.graphSyncState.findUnique({ where: { caseRef: publicCaseId } }),
    newestSourceTimestamp(caseRow.id, publicCaseId),
  ]);

  const lastSyncedAt = state?.lastSyncedAt ?? null;
  const neverSynced = !state;
  const stale =
    neverSynced ||
    (newestSource instanceof Date && lastSyncedAt instanceof Date && newestSource.getTime() > lastSyncedAt.getTime());

  const [nodeRows, edgeRows] = state
    ? await Promise.all([
        db.graphNode.findMany({ where: { caseRef: publicCaseId }, orderBy: { nodeKey: "asc" } }),
        db.graphEdge.findMany({ where: { caseRef: publicCaseId }, orderBy: { edgeKey: "asc" } }),
      ])
    : [[], []];

  const drafts: GraphNodeDraft[] = nodeRows.map((n) => ({
    nodeKey: n.nodeKey,
    nodeType: n.nodeType as GraphNodeDraft["nodeType"],
    label: n.label,
    refId: n.refId,
    entityType: n.entityType,
    classification: n.classification,
    status: n.status,
    provenance: safeParse(n.provenance),
  }));
  const edgeDrafts: GraphEdgeDraft[] = edgeRows.map((e) => ({
    edgeKey: e.edgeKey,
    sourceKey: e.sourceKey,
    targetKey: e.targetKey,
    edgeType: e.edgeType as GraphEdgeDraft["edgeType"],
    relationshipType: e.relationshipType,
    provenance: e.provenance as GraphEdgeDraft["provenance"],
    sourceRefs: safeParse(e.sourceRefs),
    confirmedByOfficerId: e.confirmedByOfficerId,
    confidence: e.confidence,
  }));

  const clearanceLevel = documentViewClearance(ctx, access);
  const filtered = filterGraphByClearance(drafts, edgeDrafts, clearanceLevel);

  // Map by stable keys — filtering reorders, so positional indexes
  // would be wrong.
  const nodeIdByKey = new Map(nodeRows.map((n) => [n.nodeKey, n.id]));
  const edgeIdByKey = new Map(edgeRows.map((e) => [e.edgeKey, e.id]));

  await recordAuditEvent({
    eventType: "GRAPH_VIEWED",
    actorOfficerId: ctx.officer.id,
    caseId: publicCaseId,
    result: "SUCCESS",
    metadata: {
      visibleNodes: filtered.nodes.length,
      visibleEdges: filtered.edges.length,
      droppedNodes: filtered.droppedNodes,
      droppedEdges: filtered.droppedEdges,
      syncVersion: state?.syncVersion ?? null,
    },
  });

  return {
    caseRef: publicCaseId,
    graph: {
      nodes: filtered.nodes.map((n) => ({ ...n, id: nodeIdByKey.get(n.nodeKey) ?? n.nodeKey })),
      edges: filtered.edges.map((e) => ({
        id: edgeIdByKey.get(e.edgeKey) ?? e.edgeKey,
        edgeKey: e.edgeKey,
        sourceKey: e.sourceKey,
        targetKey: e.targetKey,
        edgeType: e.edgeType,
        relationshipType: e.relationshipType,
        provenance: e.provenance,
        sourceRefs: e.sourceRefs,
        confirmedByOfficerId: e.confirmedByOfficerId,
        confidence: e.confidence,
      })),
    },
    sync: state
      ? {
          status: state.status,
          nodeCount: state.nodeCount,
          edgeCount: state.edgeCount,
          syncVersion: state.syncVersion,
          lastSyncedAt: state.lastSyncedAt.toISOString(),
          triggeredByOfficerId: state.triggeredByOfficerId,
        }
      : null,
    staleness: {
      neverSynced,
      stale,
      newestSourceAt: newestSource ? newestSource.toISOString() : null,
      lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
    },
    viewer: {
      clearanceLevel,
      level: access.level,
      droppedNodes: filtered.droppedNodes,
      droppedEdges: filtered.droppedEdges,
      visibleNodes: filtered.nodes.length,
      visibleEdges: filtered.edges.length,
    },
    disclaimer:
      "Derived, human-confirmed projection of central records. AI-suggested data is never a graph fact. Rebuildable at any time.",
  };
}

function safeParse(json: string | null): { model: string; id: string }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Re-exported for route use (404 handling consistency).
export { loadCaseForGraph } from "@/lib/graph/graph-sync";
