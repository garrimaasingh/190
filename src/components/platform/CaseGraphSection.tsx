"use client";

import * as React from "react";
import { api, ApiClientError, type CaseGraphPayload, type GraphNodePayload } from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import {
  Network,
  RefreshCw,
  ShieldQuestion,
  TriangleAlert,
  X,
  FileText,
  Fingerprint,
  Building2,
  Shield,
  Tag,
  User,
  MapPin,
  Car,
  Smartphone,
  Phone,
  Mail,
  Landmark,
  ArrowUpRight,
} from "lucide-react";

// ============================================================
// Phase 6 — Case knowledge graph section (spec §67).
//
// Renders the DERIVED, human-confirmed graph of this case as a
// deterministic radial layout (CASE center → departments →
// documents/evidence → entities). No external graph library, no
// force simulation — the layout is a pure function of node keys, so
// the same graph always renders identically.
//
// Visual layer (v2):
//   - curved edges (quadratic Bézier) with a deterministic bend
//   - adaptive ring radii (crowded arcs stagger onto a second radius)
//   - radial-outward labels on the outer ring to avoid overlap
//   - per-entity-type colors and glyphs inside node circles
//   - hover traces connections; click opens a node detail panel with
//     "open document / evidence" navigation for actionable nodes
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

// Entity-type specific hues (fall back to the ENTITY emerald).
const ENTITY_TYPE_COLORS: Record<string, { fill: string; stroke: string }> = {
  PERSON: { fill: "#be123c", stroke: "#9f1239" },
  ORGANIZATION: { fill: "#4f46e5", stroke: "#4338ca" },
  OFFICER: { fill: "#6d28d9", stroke: "#5b21b6" },
  LOCATION: { fill: "#0d9488", stroke: "#0f766e" },
  ADDRESS: { fill: "#15803d", stroke: "#166534" },
  VEHICLE: { fill: "#0891b2", stroke: "#0e7490" },
  DEVICE: { fill: "#7c3aed", stroke: "#6d28d9" },
  PHONE_NUMBER: { fill: "#db2777", stroke: "#be185d" },
  EMAIL: { fill: "#0369a1", stroke: "#075985" },
  COURT: { fill: "#a16207", stroke: "#854d0e" },
  POLICE_STATION: { fill: "#475569", stroke: "#334155" },
  FORENSIC_LAB: { fill: "#c2410c", stroke: "#9a3412" },
  LEGAL_SECTION: { fill: "#9333ea", stroke: "#7e22ce" },
};

const EDGE_STYLES: Record<string, { color: string; dash?: string; label: string }> = {
  STRUCTURAL: { color: "#94a3b8", label: "Structural containment" },
  HUMAN_RELATIONSHIP: { color: "#2563eb", label: "Human-created relationship" },
  AI_CONFIRMED_RELATIONSHIP: { color: "#7c3aed", dash: "6 4", label: "AI suggestion — human-confirmed" },
  VERIFIED_ENTITY: { color: "#059669", label: "Verified entity mention" },
  CONFIRMED_ENTITY_MATCH: { color: "#059669", dash: "2 4", label: "Confirmed same-entity match" },
  CASE_PARTICIPATION: { color: "#d97706", label: "Department participation" },
};

function nodeColors(node: GraphNodePayload) {
  if (node.nodeType === "ENTITY" && node.entityType && ENTITY_TYPE_COLORS[node.entityType]) {
    const c = ENTITY_TYPE_COLORS[node.entityType];
    return { ...c, text: "#f8fafc", label: NODE_COLORS.ENTITY.label };
  }
  return NODE_COLORS[node.nodeType] ?? NODE_COLORS.CASE;
}

function nodeGlyph(node: GraphNodePayload, cx: number, cy: number): React.ReactNode | null {
  const t = node.nodeType;
  const et = node.entityType ?? "";
  const size = t === "CASE" ? 22 : t === "ENTITY" ? 10 : 13;
  const common = {
    x: cx - size / 2,
    y: cy - size / 2,
    width: size,
    height: size,
    color: "currentColor",
    strokeWidth: 2.2,
    "aria-hidden": true as const,
  };
  if (t === "CASE") return <Shield {...common} />;
  if (t === "DOCUMENT") return <FileText {...common} />;
  if (t === "EVIDENCE") return <Fingerprint {...common} />;
  if (t === "DEPARTMENT") return <Building2 {...common} />;
  if (t === "ENTITY") {
    if (et === "PERSON" || et === "OFFICER") return <User {...common} />;
    if (et === "LOCATION" || et === "ADDRESS") return <MapPin {...common} />;
    if (et === "VEHICLE") return <Car {...common} />;
    if (et === "DEVICE") return <Smartphone {...common} />;
    if (et === "PHONE_NUMBER") return <Phone {...common} />;
    if (et === "EMAIL") return <Mail {...common} />;
    if (et === "COURT" || et === "POLICE_STATION" || et === "FORENSIC_LAB") return <Landmark {...common} />;
    return <Tag {...common} />;
  }
  return null;
}

interface Positioned extends GraphNodePayload {
  x: number;
  y: number;
  ring: number;
}

const VIEW_W = 900;
const VIEW_H = 680;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;

function edgePath(s: { x: number; y: number }, t: { x: number; y: number }): string {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(30, len * 0.1);
  const cx = (s.x + t.x) / 2 - (dy / len) * off;
  const cy = (s.y + t.y) / 2 + (dx / len) * off;
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)}`;
}

function layout(nodes: GraphNodePayload[]): { positioned: Positioned[]; guides: number[] } {
  const positioned: Positioned[] = [];
  const caseNode = nodes.find((n) => n.nodeType === "CASE");
  if (caseNode) {
    positioned.push({ ...caseNode, x: CENTER_X, y: CENTER_Y, ring: 0 });
  }

  const ringNodes = nodes.filter((n) => n.nodeType !== "CASE");
  const departments = ringNodes.filter((n) => n.nodeType === "DEPARTMENT");
  const items = ringNodes.filter((n) => n.nodeType === "DOCUMENT" || n.nodeType === "EVIDENCE");
  const entities = ringNodes.filter((n) => n.nodeType === "ENTITY");

  const guides: number[] = [];

  const place = (
    list: GraphNodePayload[],
    radii: number[],
    phaseOffset: number,
    ringIndex: number,
  ) => {
    const n = list.length;
    list.forEach((node, i) => {
      const angle = phaseOffset + (n === 1 ? Math.PI / 2 : (2 * Math.PI * i) / n);
      const radius = radii[i % radii.length];
      const p: Positioned = {
        ...node,
        x: CENTER_X + radius * Math.cos(angle),
        y: CENTER_Y + radius * Math.sin(angle) * 0.82, // slight vertical squash for label room
        ring: ringIndex,
      };
      positioned.push(p);
    });
  };

  // Departments (inner ring), documents/evidence (middle, staggered when
  // crowded), entities (outer, grouped by type into angular sectors with an
  // adaptive second radius). All deterministic — a function of node keys only.
  const deptRadius = 120;
  place(departments, [deptRadius], -Math.PI / 2, 1);
  guides.push(deptRadius);

  const itemsRadius = items.length > 8 ? [205, 252] : [228];
  place(
    items,
    itemsRadius,
    -Math.PI / 2 + (departments.length ? Math.PI / (2 * Math.max(departments.length, 1)) : 0),
    2,
  );
  guides.push(...itemsRadius);

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
    // Crowded sectors stagger onto a second radius so nodes never overlap.
    const radii = list.length > 5 ? [300, 348] : [324];
    const phase = -Math.PI / 2 + ti * sector + sector / 2 - Math.PI;
    place(list, radii, phase, 3);
  });

  return { positioned, guides };
}

// Wrap a label into at most 2 short lines (word-boundary aware, deterministic).
function labelLines(node: GraphNodePayload): string[] {
  const max = node.nodeType === "ENTITY" ? 15 : 20;
  const label = node.label;
  if (label.length <= max) return [label];
  let cut = label.lastIndexOf(" ", max);
  if (cut <= 0) cut = max - 1;
  const first = label.slice(0, cut);
  const rest = label.slice(cut).trim();
  if (!rest) return [first];
  if (rest.length <= max - 1) return [first, rest];
  return [first, rest.slice(0, max - 2) + "…"];
}

export function CaseGraphSection({
  caseRef,
  canManage,
  onOpenDocument,
  onOpenEvidence,
}: {
  caseRef: string;
  canManage: boolean;
  onOpenDocument?: (documentId: string, mode: "details" | "view") => void;
  onOpenEvidence?: (evidenceId: string) => void;
}) {
  const { me } = useAuth();
  const role = me?.officer.role;
  const canSync = !!canManage && role !== "AUDITOR";

  const [graph, setGraph] = React.useState<CaseGraphPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);

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
    setSelectedKey(null);
    setHoverKey(null);
  }, [load]);

  // Close the detail panel with Escape.
  React.useEffect(() => {
    if (!selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey]);

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

  const { positioned, guides } = layout(graph.graph.nodes);
  const posByKey = new Map(positioned.map((p) => [p.nodeKey, p]));
  const nodeByKey = new Map(graph.graph.nodes.map((n) => [n.nodeKey, n]));
  const nodeCount = graph.graph.nodes.length;
  const edgeCount = graph.graph.edges.length;

  const focusKey = hoverKey ?? selectedKey;
  let connectedKeys: Set<string> | null = null;
  if (focusKey) {
    connectedKeys = new Set<string>([focusKey]);
    for (const e of graph.graph.edges) {
      if (e.sourceKey === focusKey) connectedKeys.add(e.targetKey);
      if (e.targetKey === focusKey) connectedKeys.add(e.sourceKey);
    }
  }

  const selected = selectedKey ? nodeByKey.get(selectedKey) ?? null : null;
  const selectedEdges = selected
    ? graph.graph.edges.filter((e) => e.sourceKey === selected.nodeKey || e.targetKey === selected.nodeKey)
    : [];
  const selectedColor = selected ? nodeColors(selected) : null;

  const entityTypesPresent = Array.from(
    new Set(
      graph.graph.nodes
        .filter((n) => n.nodeType === "ENTITY" && n.entityType)
        .map((n) => n.entityType as string),
    ),
  ).sort();

  const dim = (key: string) => (connectedKeys && !connectedKeys.has(key) ? 0.12 : 1);

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
          <>
            <p className="text-xs text-muted-foreground">
              Hover a node to trace its connections · click a node to inspect and open it.
            </p>
            <div className="overflow-x-auto rounded-md border">
              <svg
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                role="img"
                aria-label={`Knowledge graph of case ${graph.caseRef} with ${nodeCount} nodes and ${edgeCount} edges`}
                className="min-w-[720px] w-full"
              >
                {/* ring guides */}
                {guides.map((r, i) => (
                  <ellipse
                    key={`guide-${i}-${r}`}
                    cx={CENTER_X}
                    cy={CENTER_Y}
                    rx={r}
                    ry={r * 0.82}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.07}
                    strokeDasharray="3 6"
                    className="text-foreground pointer-events-none"
                  />
                ))}

                {/* edges */}
                {graph.graph.edges.map((edge) => {
                  const s = posByKey.get(edge.sourceKey);
                  const t = posByKey.get(edge.targetKey);
                  if (!s || !t) return null; // clearance-filtered endpoint — never render
                  const style = EDGE_STYLES[edge.provenance] ?? EDGE_STYLES.STRUCTURAL;
                  const touchesFocus = !!focusKey && (edge.sourceKey === focusKey || edge.targetKey === focusKey);
                  const opacity = connectedKeys
                    ? touchesFocus
                      ? 0.95
                      : 0.08
                    : 0.65;
                  return (
                    <path
                      key={edge.edgeKey}
                      d={edgePath(s, t)}
                      fill="none"
                      stroke={style.color}
                      strokeWidth={touchesFocus ? 2.4 : 1.5}
                      strokeDasharray={style.dash}
                      opacity={opacity}
                      className="pointer-events-none"
                    >
                      <title>
                        {`${s.label} — ${edge.edgeType}${edge.relationshipType ? ` (${edge.relationshipType.replaceAll("_", " ")})` : ""} — ${t.label} · ${style.label}${edge.confidence != null ? ` · model confidence ${(edge.confidence * 100).toFixed(0)}%` : ""}`}
                      </title>
                    </path>
                  );
                })}

                {/* nodes */}
                {positioned.map((node) => {
                  const c = nodeColors(node);
                  const r = node.nodeType === "CASE" ? 30 : node.nodeType === "ENTITY" ? 13 : 17;
                  const isSelected = selectedKey === node.nodeKey;
                  const isFocused = focusKey === node.nodeKey;
                  const anchor =
                    node.ring === 3
                      ? node.x < CENTER_X - 20
                        ? "end"
                        : node.x > CENTER_X + 20
                          ? "start"
                          : "middle"
                      : "middle";
                  const lines = labelLines(node);
                  const labelX = anchor === "end" ? node.x - r - 7 : anchor === "start" ? node.x + r + 7 : node.x;
                  const labelY = anchor === "middle" ? node.y + r + 14 : node.y + 4 - (lines.length - 1) * 6;
                  const glyph = nodeGlyph(node, node.x, node.y);
                  return (
                    <g
                      key={node.nodeKey}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`${c.label}: ${node.label}. ${node.refId ? `Reference ${node.refId}. ` : ""}Click to inspect.`}
                      className="cursor-pointer outline-none"
                      style={{ opacity: dim(node.nodeKey) }}
                      onClick={() => setSelectedKey((prev) => (prev === node.nodeKey ? null : node.nodeKey))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedKey((prev) => (prev === node.nodeKey ? null : node.nodeKey));
                        }
                      }}
                      onMouseEnter={() => setHoverKey(node.nodeKey)}
                      onMouseLeave={() => setHoverKey(null)}
                    >
                      {(isSelected || isFocused) && (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={r + 5}
                          fill="none"
                          stroke={c.stroke}
                          strokeWidth={2}
                          strokeDasharray="4 3"
                        />
                      )}
                      <circle cx={node.x} cy={node.y} r={r} fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
                      {glyph && (
                        <g style={{ color: c.text }} aria-hidden>
                          {glyph}
                        </g>
                      )}
                      {node.nodeType === "CASE" && !glyph && (
                        <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill={c.text}>
                          CASE
                        </text>
                      )}
                      {lines.map((line, li) => (
                        <text
                          key={li}
                          x={labelX}
                          y={labelY + li * 12}
                          textAnchor={anchor}
                          fontSize="10.5"
                          fontWeight={isSelected ? 600 : 400}
                          className="fill-foreground"
                        >
                          {line}
                        </text>
                      ))}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* node detail panel */}
            {selected && selectedColor && (
              <div
                role="region"
                aria-label="Graph node details"
                className="rounded-md border bg-muted/30 p-4 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ background: selectedColor.fill }}
                    />
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{selected.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedColor.label}
                        {selected.entityType ? ` · ${selected.entityType.replaceAll("_", " ").toLowerCase()}` : ""}
                        {selected.refId ? ` · ${selected.refId}` : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Close node details"
                    onClick={() => setSelectedKey(null)}
                  >
                    <X aria-hidden size={14} />
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {selected.classification && (
                    <Badge variant="outline" className="text-xs">
                      {selected.classification.replaceAll("_", " ")}
                    </Badge>
                  )}
                  {selected.status && (
                    <Badge variant="outline" className="text-xs">
                      {selected.status.replaceAll("_", " ")}
                    </Badge>
                  )}
                  {selected.provenance.map((p, i) => (
                    <Badge key={`${p.model}-${p.id}-${i}`} variant="secondary" className="font-mono text-xs">
                      {p.model}
                    </Badge>
                  ))}
                </div>

                <p className="mt-3 text-xs font-medium text-muted-foreground">
                  Connections ({selectedEdges.length})
                </p>
                <ul className="mt-1.5 space-y-1">
                  {selectedEdges.length === 0 && (
                    <li className="text-xs text-muted-foreground">No visible connections.</li>
                  )}
                  {selectedEdges.map((e) => {
                    const peerKey = e.sourceKey === selected.nodeKey ? e.targetKey : e.sourceKey;
                    const peer = nodeByKey.get(peerKey);
                    const style = EDGE_STYLES[e.provenance] ?? EDGE_STYLES.STRUCTURAL;
                    if (!peer) return null;
                    return (
                      <li key={e.edgeKey} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5">
                        <span className="min-w-0 truncate text-xs">
                          <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: style.color }} />
                          <span className="font-medium">{peer.label}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            · {e.edgeType.toLowerCase()}
                            {e.relationshipType ? ` (${e.relationshipType.replaceAll("_", " ").toLowerCase()})` : ""}
                            {e.confidence != null ? ` · confidence ${(e.confidence * 100).toFixed(0)}%` : ""}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-2 text-xs"
                          onClick={() => setSelectedKey(peerKey)}
                        >
                          Focus
                        </Button>
                      </li>
                    );
                  })}
                </ul>

                {/* open actions */}
                {(selected.nodeType === "DOCUMENT" || selected.nodeType === "EVIDENCE") && selected.refId && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.nodeType === "DOCUMENT" && onOpenDocument && (
                      <Button size="sm" onClick={() => onOpenDocument(selected.refId!, "details")}>
                        <FileText aria-hidden size={14} /> Open document details
                      </Button>
                    )}
                    {selected.nodeType === "EVIDENCE" && onOpenEvidence && (
                      <Button size="sm" onClick={() => onOpenEvidence(selected.refId!)}>
                        <Fingerprint aria-hidden size={14} /> Open evidence record
                      </Button>
                    )}
                  </div>
                )}
                {selected.nodeType === "ENTITY" && onOpenDocument && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Array.from(
                      new Set(
                        selectedEdges
                          .filter((e) => e.edgeType === "MENTIONS")
                          .map((e) => (e.sourceKey === selected.nodeKey ? e.targetKey : e.sourceKey)),
                      ),
                    )
                      .map((k) => nodeByKey.get(k))
                      .filter((n): n is GraphNodePayload => !!n && n.nodeType === "DOCUMENT" && !!n.refId)
                      .slice(0, 3)
                      .map((doc) => (
                        <Button
                          key={doc.nodeKey}
                          size="sm"
                          variant="outline"
                          onClick={() => onOpenDocument(doc.refId!, "details")}
                        >
                          <ArrowUpRight aria-hidden size={14} /> Open {doc.label.length > 28 ? doc.label.slice(0, 27) + "…" : doc.label}
                        </Button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </>
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
        {entityTypesPresent.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entityTypesPresent.map((t) => {
              const c = ENTITY_TYPE_COLORS[t] ?? { fill: NODE_COLORS.ENTITY.fill };
              return (
                <span key={t} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                  <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.fill }} />
                  {t.replaceAll("_", " ").toLowerCase()}
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
