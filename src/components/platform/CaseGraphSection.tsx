"use client";

import * as React from "react";
import { api, ApiClientError, type CaseGraphPayload, type GraphNodePayload } from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { Network, RefreshCw, ShieldQuestion, TriangleAlert } from "lucide-react";

// ============================================================
// Phase 6 — Case knowledge graph section (spec §67).
//
// Renders the DERIVED, human-confirmed graph of this case as a
// deterministic radial layout (CASE center → departments →
// documents/evidence → entities). No external graph library, no
// force simulation — the layout is a pure function of node keys, so
// the same graph always renders identically.
//
// Honesty rules mirrored from the API:
//   - only human-confirmed data appears (the server never sends
//     AI-suggested facts)
//   - filtered nodes are not "greyed out" — the server never sent
//     them, so the client cannot leak their existence
//   - the section states plainly that this is a rebuildable
//     projection, not an authoritative source and not Neo4j.
// ============================================================

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string; label: string }> = {
  CASE: { fill: "#0f172a", stroke: "#0f172a", text: "#f8fafc", label: "Case" },
  DOCUMENT: { fill: "#1d4ed8", stroke: "#1e40af", text: "#eff6ff", label: "Document" },
  EVIDENCE: { fill: "#b45309", stroke: "#92400e", text: "#fffbeb", label: "Evidence" },
  ENTITY: { fill: "#047857", stroke: "#065f46", text: "#ecfdf5", label: "Entity" },
  DEPARTMENT: { fill: "#64748b", stroke: "#475569", text: "#f8fafc", label: "Department" },
};

const EDGE_STYLES: Record<string, { color: string; dash?: string; label: string }> = {
  STRUCTURAL: { color: "#94a3b8", label: "Structural containment" },
  HUMAN_RELATIONSHIP: { color: "#2563eb", label: "Human-created relationship" },
  AI_CONFIRMED_RELATIONSHIP: { color: "#7c3aed", dash: "6 4", label: "AI suggestion — human-confirmed" },
  VERIFIED_ENTITY: { color: "#059669", label: "Verified entity mention" },
  CONFIRMED_ENTITY_MATCH: { color: "#059669", dash: "2 4", label: "Confirmed same-entity match" },
  CASE_PARTICIPATION: { color: "#d97706", label: "Department participation" },
};

interface Positioned extends GraphNodePayload {
  x: number;
  y: number;
  ring: number;
}

const VIEW_W = 860;
const VIEW_H = 640;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2 - 20;

function layout(nodes: GraphNodePayload[]): Positioned[] {
  const byKey = new Map(nodes.map((n) => [n.nodeKey, n]));
  const positioned: Positioned[] = [];
  const caseNode = nodes.find((n) => n.nodeType === "CASE");
  if (caseNode) {
    positioned.push({ ...caseNode, x: CENTER_X, y: CENTER_Y, ring: 0 });
  }

  const ringNodes = nodes.filter((n) => n.nodeType !== "CASE");
  const departments = ringNodes.filter((n) => n.nodeType === "DEPARTMENT");
  const items = ringNodes.filter((n) => n.nodeType === "DOCUMENT" || n.nodeType === "EVIDENCE");
  const entities = ringNodes.filter((n) => n.nodeType === "ENTITY");

  const place = (list: GraphNodePayload[], radius: number, phaseOffset: number, ringIndex: number) => {
    const n = list.length;
    list.forEach((node, i) => {
      const angle = phaseOffset + (n === 1 ? Math.PI / 2 : (2 * Math.PI * i) / n);
      const p: Positioned = {
        ...node,
        x: CENTER_X + radius * Math.cos(angle),
        y: CENTER_Y + radius * Math.sin(angle) * 0.82, // slight vertical squash for label room
        ring: ringIndex,
      };
      positioned.push(p);
      byKey.set(node.nodeKey, node);
    });
  };

  // Departments (inner ring), documents/evidence (middle), entities (outer).
  place(departments, 130, -Math.PI / 2, 1);
  place(items, 235, -Math.PI / 2 + (departments.length ? Math.PI / (2 * Math.max(departments.length, 1)) : 0), 2);
  // Entities grouped by type: same type shares an angular sector.
  const byType = new Map<string, GraphNodePayload[]>();
  for (const e of entities) {
    const t = e.entityType ?? "OTHER";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(e);
  }
  const types = Array.from(byType.keys()).sort();
  const sector = (2 * Math.PI) / Math.max(types.length, 1);
  types.forEach((t, ti) => {
    const list = byType.get(t)!;
    place(list, 305, -Math.PI / 2 + ti * sector + sector / 2 - Math.PI, 3);
  });

  void byKey;
  return positioned;
}

function shortLabel(node: GraphNodePayload): string {
  const max = node.nodeType === "ENTITY" ? 18 : 22;
  return node.label.length > max ? node.label.slice(0, max - 1) + "…" : node.label;
}

export function CaseGraphSection({ caseRef, canManage }: { caseRef: string; canManage: boolean }) {
  const { me } = useAuth();
  const role = me?.officer.role;
  const canSync = !!canManage && role !== "AUDITOR";

  const [graph, setGraph] = React.useState<CaseGraphPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await api.get<CaseGraphPayload>(`/api/v1/graph/cases/${encodeURIComponent(caseRef)}`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load the case graph.");
    } finally {
      setLoading(false);
    }
  }, [caseRef]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function resync() {
    setSyncing(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/graph/cases/${encodeURIComponent(caseRef)}/sync`, {});
      await load();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Graph sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Network aria-hidden size={16} /> Case Graph</CardTitle>
        </CardHeader>
        <CardContent><LoadingState label="Loading case graph" rows={4} /></CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Network aria-hidden size={16} /> Case Graph</CardTitle>
        </CardHeader>
        <CardContent><ErrorState message={error} onRetry={load} /></CardContent>
      </Card>
    );
  }
  if (!graph) return null;

  const positioned = layout(graph.graph.nodes);
  const posByKey = new Map(positioned.map((p) => [p.nodeKey, p]));
  const nodeCount = graph.graph.nodes.length;
  const edgeCount = graph.graph.edges.length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Network aria-hidden size={16} /> Case Graph
              <Badge variant="secondary">{nodeCount} nodes</Badge>
              <Badge variant="secondary">{edgeCount} edges</Badge>
            </CardTitle>
            <CardDescription className="mt-1">
              {graph.disclaimer} Storage: relational projection (no external graph database).
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {graph.sync && (
              <Badge variant="outline" className="font-mono text-xs">
                v{graph.sync.syncVersion} · synced {graph.sync.lastSyncedAt ? new Date(graph.sync.lastSyncedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—"}
              </Badge>
            )}
            {canSync && (
              <Button size="sm" variant="outline" onClick={resync} disabled={syncing}>
                <RefreshCw aria-hidden size={14} className={syncing ? "animate-spin" : ""} />
                {syncing ? "Rebuilding…" : "Rebuild graph"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {graph.staleness.neverSynced && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <TriangleAlert aria-hidden size={14} />
            No graph has been built for this case yet.{canSync ? " Rebuild it to project confirmed relationships, verified entities and structure." : ""}
          </div>
        )}
        {!graph.staleness.neverSynced && graph.staleness.stale && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <TriangleAlert aria-hidden size={14} />
            The graph is stale — central case data changed after the last rebuild
            {graph.staleness.newestSourceAt ? ` (${new Date(graph.staleness.newestSourceAt).toLocaleString()})` : ""}.
            {canSync ? " Rebuild to include the latest confirmed facts." : " Ask a case manager to rebuild it."}
          </div>
        )}
        {graph.viewer.droppedNodes > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <ShieldQuestion aria-hidden size={14} />
            {graph.viewer.droppedNodes} node{graph.viewer.droppedNodes === 1 ? "" : "s"} and {graph.viewer.droppedEdges} edge
            {graph.viewer.droppedEdges === 1 ? "" : "s"} are outside your document/evidence clearance and are not shown.
          </div>
        )}
        <FieldError message={actionError || undefined} />

        {nodeCount === 0 ? (
          <EmptyState
            title="Nothing to project yet"
            description="Once the case has documents, evidence or verified entities, the confirmed graph appears here."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              role="img"
              aria-label={`Knowledge graph of case ${graph.caseRef} with ${nodeCount} nodes and ${edgeCount} edges`}
              className="min-w-[720px] w-full"
            >
              {/* edges */}
              {graph.graph.edges.map((edge) => {
                const s = posByKey.get(edge.sourceKey);
                const t = posByKey.get(edge.targetKey);
                if (!s || !t) return null; // clearance-filtered endpoint — never render
                const style = EDGE_STYLES[edge.provenance] ?? EDGE_STYLES.STRUCTURAL;
                return (
                  <line
                    key={edge.edgeKey}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={style.color}
                    strokeWidth={1.4}
                    strokeDasharray={style.dash}
                    opacity={0.75}
                  >
                    <title>
                      {`${s.label} — ${edge.edgeType}${edge.relationshipType ? ` (${edge.relationshipType.replaceAll("_", " ")})` : ""} — ${t.label} · ${style.label}${edge.confidence != null ? ` · model confidence ${(edge.confidence * 100).toFixed(0)}%` : ""}`}
                    </title>
                  </line>
                );
              })}
              {/* nodes */}
              {positioned.map((node) => {
                const c = NODE_COLORS[node.nodeType] ?? NODE_COLORS.CASE;
                const r = node.nodeType === "CASE" ? 26 : node.nodeType === "ENTITY" ? 11 : 15;
                return (
                  <g key={node.nodeKey}>
                    <circle cx={node.x} cy={node.y} r={r} fill={c.fill} stroke={c.stroke} strokeWidth={1.5}>
                      <title>
                        {`${node.nodeType} — ${node.label}${node.refId ? ` [${node.refId}]` : ""}${node.classification ? ` · ${node.classification.replaceAll("_", " ")}` : ""}${node.status ? ` · ${node.status}` : ""}${node.entityType ? ` · ${node.entityType.replaceAll("_", " ")}` : ""}`}
                      </title>
                    </circle>
                    {node.nodeType === "CASE" && (
                      <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill={c.text}>
                        CASE
                      </text>
                    )}
                    <text
                      x={node.x}
                      y={node.y + r + 13}
                      textAnchor="middle"
                      fontSize="10.5"
                      fill="currentColor"
                      className="fill-foreground"
                    >
                      {shortLabel(node)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {/* legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {Object.entries(EDGE_STYLES).map(([prov, style]) => (
            <span key={prov} className="inline-flex items-center gap-1.5">
              <svg width="22" height="8" aria-hidden>
                <line x1="0" y1="4" x2="22" y2="4" stroke={style.color} strokeWidth="2" strokeDasharray={style.dash} />
              </svg>
              {style.label}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(NODE_COLORS).map(([type, c]) => (
            <span key={type} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.fill }} />
              {c.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
