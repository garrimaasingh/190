import { db } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit/service";
import {
  caseNodeKey,
  buildEdgeKey,
  buildUndirectedEdgeKey,
  classificationLevelOf,
  classificationNameForLevel,
  departmentNodeKey,
  documentNodeKey,
  entityNodeKey,
  evidenceNodeKey,
  maxClassification,
  type GraphEdgeDraft,
  type GraphNodeDraft,
} from "@/lib/graph/graph-build";

// ============================================================
// Phase 6 — CaseGraphSyncService (spec §67/§68).
//
// Rebuilds the knowledge graph of ONE case from central data.
// Guarantees:
//   1. CONFIRMED-DATA-ONLY: AI relationship suggestions enter the
//      graph ONLY with status=CONFIRMED; entities ONLY with
//      reviewStatus=VERIFIED; entity identity edges ONLY from
//      EntityCandidateMatch rows with status=CONFIRMED whose BOTH
//      sides are still VERIFIED. SUGGESTED/REJECTED/PENDING data
//      NEVER becomes a graph fact (spec §67).
//   2. DETERMINISTIC: the same central data always produces the
//      same node/edge keys, so re-sync is idempotent.
//   3. REBUILDABLE: sync is a full delete+recreate projection
//      inside ONE transaction — the graph never holds anything the
//      central tables don't, and any drift is repairable by
//      re-running sync.
//   4. ATOMIC WITH AUDIT: the GRAPH_SYNC_COMPLETED audit event is
//      appended in the SAME transaction (fail-safe policy §48) —
//      if the audit write fails, the sync rolls back.
//   5. DERIVED, NOT AUTHORITATIVE: sync never mutates any central
//      row — documents, evidence, custody, relationships, AI data
//      are read-only inputs.
//   6. QUARANTINED documents are NEVER projected: quarantine is a
//      security state (Phase 3) — graph presence would itself be a
//      disclosure. SUPERSEDED documents stay (still legally
//      meaningful history, visible per clearance).
//
// Storage is Prisma/SQLite (MVP simulation). NO Neo4j / graph
// database functionality is claimed (spec §68 honesty).
// ============================================================

export class GraphSyncError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface SourceDocRow {
  id: string;
  documentId: string;
  title: string;
  status: string;
  classification: string;
}
interface SourceEvidenceRow {
  id: string;
  evidenceId: string;
  title: string;
  status: string;
  classification: string;
}

const SOURCE_MODELS_FOR_STALENESS = [
  "CaseDocument",
  "Evidence",
  "DocumentRelationship",
  "EvidenceDocumentRelationship",
  "AIRelationshipSuggestion",
  "ExtractedEntity",
  "EntityCandidateMatch",
  "CaseDepartment",
] as const;

export async function loadCaseForGraph(caseRef: string) {
  const caseRow = await db.case.findFirst({
    where: { OR: [{ caseId: caseRef }, { id: caseRef }] },
    select: { id: true, caseId: true, title: true, currentCustodianDepartmentId: true, originatingDepartmentId: true },
  });
  if (!caseRow) throw new GraphSyncError(404, "CASE_NOT_FOUND", "Case not found.");
  return caseRow;
}

/**
 * Newest central-row timestamp relevant to the graph. Used by the
 * read path to compute staleness honestly (computed, not stored).
 */
export async function newestSourceTimestamp(caseId: string, caseRef: string): Promise<Date | null> {
  const [docMax, evMax, docRelMax, evRelMax, aiSugMax, aiSugReviewedMax, entMax, entReviewedMax, matchMax, matchReviewedMax, deptMax] =
    await Promise.all([
      db.caseDocument.aggregate({ where: { caseId }, _max: { updatedAt: true } }),
      db.evidence.aggregate({ where: { caseId }, _max: { updatedAt: true } }),
      db.documentRelationship.aggregate({
        where: { OR: [{ sourceDocument: { caseId } }, { targetDocument: { caseId } }] },
        _max: { createdAt: true },
      }),
      db.evidenceDocumentRelationship.aggregate(
        { where: { evidence: { caseId } }, _max: { createdAt: true } }),
      db.aIRelationshipSuggestion.aggregate({ where: { caseRef }, _max: { createdAt: true } }),
      db.aIRelationshipSuggestion.aggregate({ where: { caseRef }, _max: { reviewedAt: true } }),
      db.extractedEntity.aggregate({ where: { caseRef }, _max: { createdAt: true } }),
      db.extractedEntity.aggregate({ where: { caseRef }, _max: { reviewedAt: true } }),
      db.entityCandidateMatch.aggregate({
        where: { entityA: { caseRef } },
        _max: { createdAt: true },
      }),
      db.entityCandidateMatch.aggregate({
        where: { entityA: { caseRef } },
        _max: { reviewedAt: true },
      }),
      db.caseDepartment.aggregate({ where: { caseId }, _max: { joinedAt: true } }),
    ]);
  const candidates = [
    docMax._max.updatedAt,
    evMax._max.updatedAt,
    docRelMax._max.createdAt,
    evRelMax._max.createdAt,
    aiSugMax._max.createdAt,
    aiSugReviewedMax._max.reviewedAt,
    entMax._max.createdAt,
    entReviewedMax._max.reviewedAt,
    matchMax._max.createdAt,
    matchReviewedMax._max.reviewedAt,
    deptMax._max.joinedAt,
  ].filter((d): d is Date => d instanceof Date);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a > b ? a : b));
}

export interface GraphSyncResult {
  caseRef: string;
  syncVersion: number;
  nodeCount: number;
  edgeCount: number;
  lastSyncedAt: Date;
  provenanceCounts: Record<string, number>;
}

export async function syncCaseGraph(
  caseRef: string,
  opts: { triggeredByOfficerId?: string | null } = {}
): Promise<GraphSyncResult> {
  const caseRow = await loadCaseForGraph(caseRef);
  const internalCaseId = caseRow.id;
  const publicCaseId = caseRow.caseId;

  // ---- Load ALL source data (reads outside the tx are fine; the
  // tx rebuilds from these snapshots deterministically) ----
  const [caseDepartments, custodianDept, originDept, docs, evidence, docRelationships, evidenceRelationships, aiConfirmed, verifiedEntities, confirmedMatches] =
    await Promise.all([
      db.caseDepartment.findMany({
        where: { caseId: internalCaseId, status: "ACTIVE" },
        include: { department: { select: { id: true, departmentCode: true, name: true } } },
      }),
      db.department.findUnique({
        where: { id: caseRow.currentCustodianDepartmentId },
        select: { id: true, departmentCode: true, name: true },
      }),
      db.department.findUnique({
        where: { id: caseRow.originatingDepartmentId },
        select: { id: true, departmentCode: true, name: true },
      }),
      db.caseDocument.findMany({
        where: { caseId: internalCaseId },
        select: { id: true, documentId: true, title: true, status: true, classification: true },
      }),
      db.evidence.findMany({
        where: { caseId: internalCaseId },
        select: { id: true, evidenceId: true, title: true, status: true, classification: true },
      }),
      db.documentRelationship.findMany({
        where: { OR: [{ sourceDocument: { caseId: internalCaseId } }, { targetDocument: { caseId: internalCaseId } }] },
        select: {
          id: true,
          sourceDocumentId: true,
          targetDocumentId: true,
          relationshipType: true,
          createdByOfficerId: true,
        },
      }),
      db.evidenceDocumentRelationship.findMany({
        where: { evidence: { caseId: internalCaseId } },
        select: {
          id: true,
          evidenceId: true,
          documentId: true,
          relationshipType: true,
          createdByOfficerId: true,
        },
      }),
      db.aIRelationshipSuggestion.findMany({
        where: { caseRef: publicCaseId, status: "CONFIRMED" },
        select: {
          id: true,
          sourceDocumentId: true,
          targetDocumentId: true,
          relationshipType: true,
          confidence: true,
          reviewedByOfficerId: true,
        },
      }),
      db.extractedEntity.findMany({
        where: { caseRef: publicCaseId, reviewStatus: "VERIFIED" },
        select: {
          id: true,
          entityType: true,
          normalizedValue: true,
          originalText: true,
          documentId: true,
          document: { select: { classification: true } },
        },
      }),
      db.entityCandidateMatch.findMany({
        where: {
          status: "CONFIRMED",
          entityA: { caseRef: publicCaseId, reviewStatus: "VERIFIED" },
          entityB: { caseRef: publicCaseId, reviewStatus: "VERIFIED" },
        },
        select: {
          id: true,
          entityAId: true,
          entityBId: true,
          reviewedByOfficerId: true,
          entityA: { select: { entityType: true, normalizedValue: true, originalText: true } },
          entityB: { select: { entityType: true, normalizedValue: true, originalText: true } },
        },
      }),
    ]);

  const nodes = new Map<string, GraphNodeDraft>();
  const edges = new Map<string, GraphEdgeDraft>();

  const addNode = (draft: GraphNodeDraft) => {
    if (!nodes.has(draft.nodeKey)) nodes.set(draft.nodeKey, draft);
  };
  const addEdge = (draft: Omit<GraphEdgeDraft, "edgeKey"> & { edgeKey?: string }) => {
    const edgeKey =
      draft.edgeKey ??
      buildEdgeKey(draft.sourceKey, draft.edgeType, draft.targetKey, draft.relationshipType, draft.provenance);
    if (!edges.has(edgeKey)) edges.set(edgeKey, { ...draft, edgeKey });
  };

  // ---- CASE node ----
  const caseKey = caseNodeKey(publicCaseId);
  addNode({
    nodeKey: caseKey,
    nodeType: "CASE",
    label: caseRow.title,
    refId: publicCaseId,
    entityType: null,
    classification: null,
    status: null,
    provenance: [{ model: "Case", id: internalCaseId }],
  });

  // ---- DEPARTMENT nodes + PARTICIPATION edges (structural) ----
  const deptSeen = new Map<string, { code: string; name: string; roles: string[]; ids: string[] }>();
  const noteDept = (
    dept: { id: string; departmentCode: string; name: string } | null,
    role: string
  ) => {
    if (!dept) return;
    const existing = deptSeen.get(dept.id);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else {
      deptSeen.set(dept.id, { code: dept.departmentCode, name: dept.name, roles: [role], ids: [dept.id] });
    }
  };
  noteDept(custodianDept, "ACTIVE_CUSTODIAN");
  noteDept(originDept, "ORIGINATING");
  for (const cd of caseDepartments) noteDept(cd.department, cd.participationType);
  for (const dept of deptSeen.values()) {
    const key = departmentNodeKey(dept.code);
    addNode({
      nodeKey: key,
      nodeType: "DEPARTMENT",
      label: dept.name,
      refId: dept.code,
      entityType: null,
      classification: null,
      status: null,
      provenance: dept.ids.map((id) => ({ model: "Department", id })),
    });
    addEdge({
      sourceKey: caseKey,
      targetKey: key,
      edgeType: "PARTICIPATION",
      relationshipType: dept.roles.sort().join("+"),
      provenance: "CASE_PARTICIPATION",
      sourceRefs: dept.ids.map((id) => ({ model: "CaseDepartment", id })),
      confirmedByOfficerId: null,
      confidence: null,
    });
  }

  // ---- DOCUMENT nodes + CONTAINS edges (structural). QUARANTINED
  // documents are never projected (security state — spec honesty). ----
  const docKeyById = new Map<string, string>();
  const projectedDocs: SourceDocRow[] = [];
  for (const doc of docs) {
    if (doc.status === "QUARANTINED") continue;
    const key = documentNodeKey(doc.documentId);
    docKeyById.set(doc.id, key);
    projectedDocs.push(doc);
    addNode({
      nodeKey: key,
      nodeType: "DOCUMENT",
      label: doc.title,
      refId: doc.documentId,
      entityType: null,
      classification: doc.classification,
      status: doc.status,
      provenance: [{ model: "CaseDocument", id: doc.id }],
    });
    addEdge({
      sourceKey: caseKey,
      targetKey: key,
      edgeType: "CONTAINS",
      relationshipType: null,
      provenance: "STRUCTURAL",
      sourceRefs: [{ model: "CaseDocument", id: doc.id }],
      confirmedByOfficerId: null,
      confidence: null,
    });
  }

  // ---- EVIDENCE nodes + CONTAINS edges ----
  const evidenceRows: SourceEvidenceRow[] = evidence;
  const evKeyById = new Map<string, string>();
  for (const ev of evidenceRows) {
    const key = evidenceNodeKey(ev.evidenceId);
    evKeyById.set(ev.id, key);
    addNode({
      nodeKey: key,
      nodeType: "EVIDENCE",
      label: ev.title,
      refId: ev.evidenceId,
      entityType: null,
      classification: ev.classification,
      status: ev.status,
      provenance: [{ model: "Evidence", id: ev.id }],
    });
    addEdge({
      sourceKey: caseKey,
      targetKey: key,
      edgeType: "CONTAINS",
      relationshipType: null,
      provenance: "STRUCTURAL",
      sourceRefs: [{ model: "Evidence", id: ev.id }],
      confirmedByOfficerId: null,
      confidence: null,
    });
  }

  // ---- HUMAN document relationships (Phase 3) ----
  for (const rel of docRelationships) {
    const sourceKey = docKeyById.get(rel.sourceDocumentId);
    const targetKey = docKeyById.get(rel.targetDocumentId);
    if (!sourceKey || !targetKey) continue; // cross-case or quarantined endpoint — never projected
    addEdge({
      sourceKey,
      targetKey,
      edgeType: "RELATIONSHIP",
      relationshipType: rel.relationshipType,
      provenance: "HUMAN_RELATIONSHIP",
      sourceRefs: [{ model: "DocumentRelationship", id: rel.id }],
      confirmedByOfficerId: rel.createdByOfficerId,
      confidence: null,
    });
  }

  // ---- HUMAN evidence↔document relationships (Phase 4; direction
  // DOCUMENT → EVIDENCE per schema comment, spec §20) ----
  for (const rel of evidenceRelationships) {
    const docKey = docKeyById.get(rel.documentId);
    const evKey = evKeyById.get(rel.evidenceId);
    if (!docKey || !evKey) continue;
    addEdge({
      sourceKey: docKey,
      targetKey: evKey,
      edgeType: "RELATIONSHIP",
      relationshipType: rel.relationshipType,
      provenance: "HUMAN_RELATIONSHIP",
      sourceRefs: [{ model: "EvidenceDocumentRelationship", id: rel.id }],
      confirmedByOfficerId: rel.createdByOfficerId,
      confidence: null,
    });
  }

  // ---- HUMAN-CONFIRMED AI relationship suggestions (Phase 5, spec §67) ----
  for (const rel of aiConfirmed) {
    const sourceKey = docKeyById.get(rel.sourceDocumentId);
    const targetKey = docKeyById.get(rel.targetDocumentId);
    if (!sourceKey || !targetKey) continue;
    addEdge({
      sourceKey,
      targetKey,
      edgeType: "RELATIONSHIP",
      relationshipType: rel.relationshipType,
      provenance: "AI_CONFIRMED_RELATIONSHIP",
      sourceRefs: [{ model: "AIRelationshipSuggestion", id: rel.id }],
      confirmedByOfficerId: rel.reviewedByOfficerId,
      confidence: rel.confidence,
    });
  }

  // ---- VERIFIED entity mentions → ENTITY nodes (Phase 5) ----
  // Entity nodes carry the MAX classification of their supporting
  // documents so read-time clearance filtering stays airtight.
  interface EntityAgg {
    key: string;
    entityType: string;
    label: string;
    docIds: string[];
    docClassifications: string[];
    entityRowIds: string[];
  }
  const entityAggs = new Map<string, EntityAgg>();
  const entityRowToKey = new Map<string, string>();
  for (const ent of verifiedEntities) {
    const displayValue = (ent.normalizedValue && ent.normalizedValue.trim()) || ent.originalText.trim();
    const key = entityNodeKey(ent.entityType, displayValue);
    let agg = entityAggs.get(key);
    if (!agg) {
      agg = { key, entityType: ent.entityType, label: displayValue, docIds: [], docClassifications: [], entityRowIds: [] };
      entityAggs.set(key, agg);
    }
    agg.docIds.push(ent.documentId);
    agg.docClassifications.push(ent.document.classification);
    agg.entityRowIds.push(ent.id);
    entityRowToKey.set(ent.id, key);
  }
  for (const agg of entityAggs.values()) {
    const topLevel = maxClassification(...agg.docClassifications.map((c) => classificationLevelOf(c)));
    addNode({
      nodeKey: agg.key,
      nodeType: "ENTITY",
      label: agg.label,
      refId: null,
      entityType: agg.entityType,
      classification: classificationNameForLevel(topLevel),
      status: null,
      provenance: agg.entityRowIds.slice(0, 50).map((id) => ({ model: "ExtractedEntity", id })),
    });
    const uniqueDocIds = Array.from(new Set(agg.docIds));
    for (const docId of uniqueDocIds) {
      const docKey = docKeyById.get(docId);
      if (!docKey) continue; // quarantined/cross-case supporting doc — skip this mention edge
      addEdge({
        sourceKey: docKey,
        targetKey: agg.key,
        edgeType: "MENTIONS",
        relationshipType: agg.entityType,
        provenance: "VERIFIED_ENTITY",
        sourceRefs: [], // filled below per-row for traceability
        confirmedByOfficerId: null,
        confidence: null,
      });
    }
    // attach per-row source refs to the corresponding MENTIONS edges
    for (let i = 0; i < agg.entityRowIds.length; i++) {
      const entRowId = agg.entityRowIds[i];
      const docId = agg.docIds[i];
      const docKey = docKeyById.get(docId);
      if (!docKey) continue;
      const edgeKey = buildEdgeKey(docKey, "MENTIONS", agg.key, agg.entityType, "VERIFIED_ENTITY");
      const edge = edges.get(edgeKey);
      if (edge && !edge.sourceRefs.some((r) => r.id === entRowId)) {
        edge.sourceRefs.push({ model: "ExtractedEntity", id: entRowId });
      }
    }
  }

  // ---- CONFIRMED entity matches → SAME_ENTITY edges (never a merge) ----
  for (const match of confirmedMatches) {
    const keyA = entityRowToKey.get(match.entityAId);
    const keyB = entityRowToKey.get(match.entityBId);
    if (!keyA || !keyB || keyA === keyB) continue;
    const undirected = buildUndirectedEdgeKey(keyA, "SAME_ENTITY", keyB, "CONFIRMED_ENTITY_MATCH");
    addEdge({
      ...undirected,
      edgeType: "SAME_ENTITY",
      relationshipType: null,
      provenance: "CONFIRMED_ENTITY_MATCH",
      sourceRefs: [{ model: "EntityCandidateMatch", id: match.id }],
      confirmedByOfficerId: match.reviewedByOfficerId,
      confidence: null,
    });
  }

  const nodeRows = Array.from(nodes.values());
  const edgeRows = Array.from(edges.values());

  // ---- Deterministic rebuild + state upsert + audit in ONE tx ----
  const now = new Date();
  const provenanceCounts: Record<string, number> = {};
  for (const e of edgeRows) provenanceCounts[e.provenance] = (provenanceCounts[e.provenance] ?? 0) + 1;

  const result = await db.$transaction(async (tx) => {
    await tx.graphEdge.deleteMany({ where: { caseRef: publicCaseId } });
    await tx.graphNode.deleteMany({ where: { caseRef: publicCaseId } });

    await tx.graphNode.createMany({
      data: nodeRows.map((n) => ({
        caseRef: publicCaseId,
        nodeKey: n.nodeKey,
        nodeType: n.nodeType,
        label: n.label,
        refId: n.refId,
        entityType: n.entityType,
        classification: n.classification,
        status: n.status,
        provenance: JSON.stringify(n.provenance),
      })),
    });
    await tx.graphEdge.createMany({
      data: edgeRows.map((e) => ({
        caseRef: publicCaseId,
        edgeKey: e.edgeKey,
        sourceKey: e.sourceKey,
        targetKey: e.targetKey,
        edgeType: e.edgeType,
        relationshipType: e.relationshipType,
        provenance: e.provenance,
        sourceRefs: JSON.stringify(e.sourceRefs),
        confirmedByOfficerId: e.confirmedByOfficerId,
        confidence: e.confidence,
        createdAt: now,
      })),
    });

    const prev = await tx.graphSyncState.findUnique({ where: { caseRef: publicCaseId } });
    const state = prev
      ? await tx.graphSyncState.update({
          where: { caseRef: publicCaseId },
          data: {
            status: "SYNCED",
            nodeCount: nodeRows.length,
            edgeCount: edgeRows.length,
            syncVersion: { increment: 1 },
            lastSyncedAt: now,
            lastError: null,
            triggeredByOfficerId: opts.triggeredByOfficerId ?? null,
          },
        })
      : await tx.graphSyncState.create({
          data: {
            caseRef: publicCaseId,
            status: "SYNCED",
            nodeCount: nodeRows.length,
            edgeCount: edgeRows.length,
            syncVersion: 1,
            lastSyncedAt: now,
            lastError: null,
            triggeredByOfficerId: opts.triggeredByOfficerId ?? null,
          },
        });

    await appendAuditEvent(
      {
        eventType: "GRAPH_SYNC_COMPLETED",
        actorOfficerId: opts.triggeredByOfficerId ?? null,
        caseId: publicCaseId,
        result: "SUCCESS",
        metadata: {
          syncVersion: state.syncVersion,
          nodeCount: nodeRows.length,
          edgeCount: edgeRows.length,
          provenanceCounts,
          algorithm: "deterministic-full-rebuild",
        },
        timestamp: now,
      },
      tx
    );

    return state;
  });

  return {
    caseRef: publicCaseId,
    syncVersion: result.syncVersion,
    nodeCount: nodeRows.length,
    edgeCount: edgeRows.length,
    lastSyncedAt: result.lastSyncedAt,
    provenanceCounts,
  };
}

export { SOURCE_MODELS_FOR_STALENESS };
