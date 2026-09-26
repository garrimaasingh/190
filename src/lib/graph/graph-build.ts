import { createHash } from "crypto";
import {
  DOCUMENT_CLASSIFICATION_LEVEL,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  type GraphEdgeProvenance,
  type GraphEdgeType,
  type GraphNodeType,
} from "@/lib/constants";

// ============================================================
// Phase 6 — Case knowledge graph BUILDERS (spec §67/§68).
//
// Pure, deterministic functions shared by the sync service and the
// test suite. NOTHING here touches the database. Every node key and
// edge key is a pure function of central-record identities, so two
// syncs over identical central data produce byte-identical graphs
// (idempotency is testable, not assumed).
//
// The graph is a DERIVED projection: it stores references and
// labels only — never file content, hashes of plaintext documents
// beyond what the central rows already expose, or any secret
// material (spec §68: no binaries in the graph).
// ============================================================

export interface GraphNodeDraft {
  nodeKey: string;
  nodeType: GraphNodeType;
  label: string;
  refId: string | null;
  entityType: string | null;
  classification: string | null;
  status: string | null;
  provenance: { model: string; id: string }[];
}

export interface GraphEdgeDraft {
  edgeKey: string;
  sourceKey: string;
  targetKey: string;
  edgeType: GraphEdgeType;
  relationshipType: string | null;
  provenance: GraphEdgeProvenance;
  sourceRefs: { model: string; id: string }[];
  confirmedByOfficerId: string | null;
  confidence: number | null;
}

/** Stable slug for entity values: readable + collision-tolerant. */
export function slugifyEntityValue(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]+/g, "-") // keep Devanagari (Hindi entities) intact
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // Values that reduce to nothing (pure punctuation) fall back to a
  // short digest so the key stays stable and non-empty.
  if (!base) return "v-" + createHash("sha256").update(value.trim()).digest("hex").slice(0, 10);
  return base;
}

export function caseNodeKey(caseId: string): string {
  return `CASE:${caseId}`;
}

export function documentNodeKey(documentId: string): string {
  return `DOC:${documentId}`;
}

export function evidenceNodeKey(evidenceId: string): string {
  return `EVD:${evidenceId}`;
}

export function departmentNodeKey(departmentCode: string): string {
  return `DEPT:${departmentCode}`;
}

export function entityNodeKey(entityType: string, value: string): string {
  return `ENT:${entityType}:${slugifyEntityValue(value)}`;
}

/**
 * Deterministic edge key. The provenance is PART of the key so the
 * same pair can legitimately carry a human relationship AND a
 * separately-confirmed AI relationship without silent overwriting.
 */
export function buildEdgeKey(
  sourceKey: string,
  edgeType: GraphEdgeType,
  targetKey: string,
  relationshipType: string | null,
  provenance: GraphEdgeProvenance
): string {
  const rel = relationshipType ? `:${relationshipType}` : "";
  return `${sourceKey}>${edgeType}${rel}#${provenance}>${targetKey}`;
}

/**
 * Undirected edge key (SAME_ENTITY): source/target order is
 * normalized so A–B and B–A are the same fact, deterministically.
 */
export function buildUndirectedEdgeKey(
  keyA: string,
  edgeType: GraphEdgeType,
  keyB: string,
  provenance: GraphEdgeProvenance
): { edgeKey: string; sourceKey: string; targetKey: string } {
  const [sourceKey, targetKey] = [keyA, keyB].sort();
  return {
    edgeKey: buildEdgeKey(sourceKey, edgeType, targetKey, null, provenance),
    sourceKey,
    targetKey,
  };
}

export function classificationLevelOf(classification: string | null | undefined): number {
  if (!classification) return -1; // no classification → no clearance constraint (CASE/DEPT nodes)
  const level = DOCUMENT_CLASSIFICATION_LEVEL[classification];
  return level === undefined ? 99 : level; // unknown → effectively unreachable
}

/**
 * Applies read-time clearance filtering to a projected graph.
 * Nodes ABOVE the viewer's clearance are dropped entirely (no label,
 * no existence signal), then any edge touching a dropped node is
 * dropped too — a surviving edge must never hint at a hidden node.
 */
export function filterGraphByClearance(
  nodes: GraphNodeDraft[],
  edges: GraphEdgeDraft[],
  clearanceLevel: number
): { nodes: GraphNodeDraft[]; edges: GraphEdgeDraft[]; droppedNodes: number; droppedEdges: number } {
  const visibleKeys = new Set<string>();
  let droppedNodes = 0;
  for (const node of nodes) {
    if (classificationLevelOf(node.classification) > clearanceLevel) {
      droppedNodes += 1;
      continue;
    }
    visibleKeys.add(node.nodeKey);
  }
  const keptEdges: GraphEdgeDraft[] = [];
  let droppedEdges = 0;
  for (const edge of edges) {
    if (!visibleKeys.has(edge.sourceKey) || !visibleKeys.has(edge.targetKey)) {
      droppedEdges += 1;
      continue;
    }
    keptEdges.push(edge);
  }
  return {
    nodes: nodes.filter((n) => visibleKeys.has(n.nodeKey)).slice(0, GRAPH_MAX_NODES),
    edges: keptEdges.slice(0, GRAPH_MAX_EDGES),
    droppedNodes,
    droppedEdges,
  };
}

/** Max classification level across supporting rows (for ENTITY nodes). */
export function maxClassification(...levels: number[]): number {
  return levels.reduce((acc, l) => (l > acc ? l : acc), -1);
}

export function classificationNameForLevel(level: number): string | null {
  const found = Object.entries(DOCUMENT_CLASSIFICATION_LEVEL).find(([, l]) => l === level);
  return found ? found[0] : null;
}
