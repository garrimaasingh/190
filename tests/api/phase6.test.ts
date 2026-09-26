/**
 * Phase 6 API & security test suite — Case Knowledge Graph.
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase6.test.ts
 *
 * Covers Phase 6 spec §67/§68: deterministic graph builders
 * (node/edge keys, undirected normalization, clearance filtering),
 * confirmed-data-only projection (SUGGESTED/PENDING AI data NEVER
 * becomes a graph fact), human relationships and verified entities,
 * read-time classification clearance (filtered nodes leak neither
 * labels nor existence via edges), cross-case isolation, sync
 * authorization (role + case-level manage), staleness computation,
 * idempotent rebuilds, quarantine exclusion, audit integration
 * (GRAPH_* events inside the immutable chain) and central-record
 * immutability (graph sync never touches documents/evidence/custody).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { verifyChain } from "@/lib/audit/integrity";
import {
  slugifyEntityValue,
  buildEdgeKey,
  buildUndirectedEdgeKey,
  filterGraphByClearance,
  entityNodeKey,
} from "@/lib/graph/graph-build";

const BASE = "http://localhost:3000";
function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 90000);
}
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a", "connection": "close" };

const CASE1 = "CASE-MP-IND-2026-000001";
const CASE2 = "CASE-MP-IND-2026-000002";

// ---------- helpers ----------

class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = { ...BYPASS, ...(extraHeaders || {}) };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
    this.lastStatus = res.status;
    const text = await res.text();
    try {
      this.lastBody = JSON.parse(text);
    } catch {
      this.lastBody = { raw: text };
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      if (this.cookie === null || method === "POST") this.cookie = pair;
      else this.cookie = pair;
    }
    return this.lastBody;
  }

  get(path: string, headers?: Record<string, string>) {
    return this.req("GET", path, undefined, headers);
  }
  post(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.req("POST", path, body, headers);
  }
  login(email: string, password = SEED_PASSWORD) {
    return this.req("POST", "/api/v1/auth/login", { email, password });
  }
  code() {
    return this.lastBody?.error?.code;
  }
  data() {
    return this.lastBody?.data;
  }
}

function txtFile(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

async function uploadDocument(
  client: Client,
  caseRef: string,
  doc: { title: string; type: string; classification: string; filename: string; bytes: Buffer; mime?: string; description?: string }
): Promise<{ documentId: string; sha256Hash: string }> {
  const form = new FormData();
  form.append("title", doc.title);
  form.append("documentType", doc.type);
  form.append("classification", doc.classification);
  if (doc.description) form.append("description", doc.description);
  form.append("file", new Blob([new Uint8Array(doc.bytes)], { type: doc.mime || "text/plain" }), doc.filename);
  await client.post(`/api/v1/cases/${caseRef}/documents`, form);
  expect([201, 200]).toContain(client.lastStatus);
  const d = client.data().document;
  return { documentId: d.id, sha256Hash: d.sha256Hash };
}

function graphPath(caseRef: string) {
  return `/api/v1/graph/cases/${encodeURIComponent(caseRef)}`;
}

/** GET with ONE retry on 5xx (reads are idempotent). */
async function getStable(client: Client, path: string) {
  await client.get(path);
  if (client.lastStatus >= 500) await client.get(path);
  return client.lastStatus;
}

/** POST with ONE retry on 5xx — authorization assertions must not fail on
 * transient dev-server 500s under sandbox load (documented pattern). */
async function postStable(client: Client, path: string, body?: unknown) {
  await client.post(path, body);
  if (client.lastStatus >= 500) await client.post(path, body);
  return client.lastStatus;
}

let arjun: Client;
let vishnu: Client;
let devika: Client;
let priya: Client;
let sysadmin: Client;

beforeAll(async () => {
  arjun = new Client();
  await arjun.login("arjun.sharma@demo.gov.in");
  vishnu = new Client();
  await vishnu.login("vishnu.kumar@demo.gov.in");
  devika = new Client();
  await devika.login("devika.iyer@demo.gov.in");
  priya = new Client();
  await priya.login("priya.nair@demo.gov.in");
  sysadmin = new Client();
  await sysadmin.login("sysadmin@demo.gov.in");
});

// ============================================================
// 1. Unit — deterministic builders (spec §67)
// ============================================================
describe("graph builders (unit)", () => {
  t("node keys are pure functions of central identities", () => {
    expect(entityNodeKey("PERSON", "Ram Kumar")).toBe(entityNodeKey("PERSON", "  ram  kumar "));
    expect(entityNodeKey("PERSON", "Ram Kumar")).not.toBe(entityNodeKey("ORGANIZATION", "Ram Kumar"));
    expect(slugifyEntityValue("लखनऊ")).toContain("लखनऊ"); // Devanagari preserved
    expect(slugifyEntityValue("!!!")).toMatch(/^v-[0-9a-f]{10}$/); // digest fallback
  });

  t("edge keys embed relationship + provenance; undirected keys normalize order", () => {
    const a = "DOC:A";
    const b = "DOC:B";
    const human = buildEdgeKey(a, "RELATIONSHIP", b, "SUPPLEMENT", "HUMAN_RELATIONSHIP");
    const ai = buildEdgeKey(a, "RELATIONSHIP", b, "SUPPLEMENT", "AI_CONFIRMED_RELATIONSHIP");
    expect(human).not.toBe(ai); // same pair, two facts — no silent overwrite
    const k1 = buildUndirectedEdgeKey(a, "SAME_ENTITY", b, "CONFIRMED_ENTITY_MATCH");
    const k2 = buildUndirectedEdgeKey(b, "SAME_ENTITY", a, "CONFIRMED_ENTITY_MATCH");
    expect(k1.edgeKey).toBe(k2.edgeKey);
    expect(k1.sourceKey < k1.targetKey).toBe(true);
  });

  t("clearance filter drops nodes ABOVE clearance and every edge touching them", () => {
    const nodes = [
      { nodeKey: "CASE:C", nodeType: "CASE" as const, label: "c", refId: null, entityType: null, classification: null, status: null, provenance: [] },
      { nodeKey: "DOC:LOW", nodeType: "DOCUMENT" as const, label: "l", refId: null, entityType: null, classification: "INTERNAL", status: null, provenance: [] },
      { nodeKey: "DOC:HIGH", nodeType: "DOCUMENT" as const, label: "h", refId: null, entityType: null, classification: "HIGHLY_RESTRICTED", status: null, provenance: [] },
      { nodeKey: "ENT:PERSON:x", nodeType: "ENTITY" as const, label: "x", refId: null, entityType: "PERSON", classification: "RESTRICTED", status: null, provenance: [] },
    ];
    const edges = [
      { edgeKey: "e1", sourceKey: "CASE:C", targetKey: "DOC:LOW", edgeType: "CONTAINS" as const, relationshipType: null, provenance: "STRUCTURAL" as const, sourceRefs: [], confirmedByOfficerId: null, confidence: null },
      { edgeKey: "e2", sourceKey: "CASE:C", targetKey: "DOC:HIGH", edgeType: "CONTAINS" as const, relationshipType: null, provenance: "STRUCTURAL" as const, sourceRefs: [], confirmedByOfficerId: null, confidence: null },
      { edgeKey: "e3", sourceKey: "DOC:HIGH", targetKey: "ENT:PERSON:x", edgeType: "MENTIONS" as const, relationshipType: "PERSON", provenance: "VERIFIED_ENTITY" as const, sourceRefs: [], confirmedByOfficerId: null, confidence: null },
      { edgeKey: "e4", sourceKey: "DOC:LOW", targetKey: "ENT:PERSON:x", edgeType: "MENTIONS" as const, relationshipType: "PERSON", provenance: "VERIFIED_ENTITY" as const, sourceRefs: [], confirmedByOfficerId: null, confidence: null },
    ];
    const r = filterGraphByClearance(nodes, edges, 3); // RESTRICTED ceiling
    const keys = r.nodes.map((n) => n.nodeKey);
    expect(keys).not.toContain("DOC:HIGH");
    expect(keys).toContain("DOC:LOW");
    expect(r.edges.map((e) => e.edgeKey).sort()).toEqual(["e1", "e4"]); // e2/e3 touch the hidden node
    expect(r.droppedNodes).toBe(1);
    expect(r.droppedEdges).toBe(2);
  });
});

// ============================================================
// 2. Graph read — seeded projection
// ============================================================
describe("GET graph — seeded case 1", () => {
  t("custodian admin gets the graph: case/document/evidence/entity/department nodes, fresh staleness", async () => {
    await getStable(arjun, graphPath(CASE1));
    expect(arjun.lastStatus).toBe(200);
    const g = arjun.data();
    expect(g.caseRef).toBe(CASE1);
    const types = new Set(g.graph.nodes.map((n: any) => n.nodeType));
    expect(types.has("CASE")).toBe(true);
    expect(types.has("DEPARTMENT")).toBe(true);
    // seed created documents + evidence + verified entities on case 1
    expect(types.has("DOCUMENT")).toBe(true);
    expect(types.has("EVIDENCE")).toBe(true);
    expect(types.has("ENTITY")).toBe(true);
    expect(g.graph.nodes.some((n: any) => n.nodeKey === `CASE:${CASE1}`)).toBe(true);
    expect(g.graph.nodes.every((n: any) => n.nodeKey.startsWith("DOC:") || n.classification == null || n.classification.length > 0)).toBe(true);
    expect(g.staleness.neverSynced).toBe(false);
    expect(g.staleness.stale).toBe(false);
    expect(g.sync.syncVersion).toBeGreaterThanOrEqual(1);
    expect(typeof g.disclaimer).toBe("string");
  });

  t("seed's human-confirmed AI suggestion is an edge with confidence + confirm; suggested data is NOT", async () => {
    await getStable(arjun, graphPath(CASE1));
    const edges = arjun.data().graph.edges;
    const aiEdges = edges.filter((e: any) => e.provenance === "AI_CONFIRMED_RELATIONSHIP");
    expect(aiEdges.length).toBeGreaterThanOrEqual(1); // seed confirmed one REFERENCE suggestion
    // the SEEDED fact (REFERENCE) must be present; later fixtures may add others
    const seeded = aiEdges.find((e: any) => e.relationshipType === "REFERENCE");
    expect(seeded).toBeDefined();
    for (const e of aiEdges) {
      expect(e.confidence).not.toBeNull();
      expect(e.confirmedByOfficerId).not.toBeNull();
      expect(e.sourceRefs[0].model).toBe("AIRelationshipSuggestion");
    }
    // and every edge provenance is from the registry
    for (const e of edges) {
      expect(["STRUCTURAL", "HUMAN_RELATIONSHIP", "AI_CONFIRMED_RELATIONSHIP", "VERIFIED_ENTITY", "CONFIRMED_ENTITY_MATCH", "CASE_PARTICIPATION"]).toContain(e.provenance);
    }
  });

  t("verified entity mentions exist with per-row traceability; entity node classification ≤ its docs", async () => {
    await getStable(arjun, graphPath(CASE1));
    const { nodes, edges } = arjun.data().graph;
    const mentionEdges = edges.filter((e: any) => e.provenance === "VERIFIED_ENTITY");
    expect(mentionEdges.length).toBeGreaterThanOrEqual(1);
    for (const e of mentionEdges) {
      expect(e.edgeType).toBe("MENTIONS");
      expect(e.sourceRefs.length).toBeGreaterThanOrEqual(1);
      expect(e.sourceRefs.every((r: any) => r.model === "ExtractedEntity")).toBe(true);
    }
    const entityNodes = nodes.filter((n: any) => n.nodeType === "ENTITY");
    for (const n of entityNodes) {
      expect(n.classification == null || ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"].includes(n.classification)).toBe(true);
    }
  });
});

// ============================================================
// 3. Confirmed-data-only gate + staleness + idempotency
// ============================================================
describe("sync — confirmed-only, stale, idempotent", () => {
  let suggestedId: string;

  t("SUGGESTED AI suggestion never becomes a graph fact; confirming it later does (stale → sync)", async () => {
    // fixture: a fresh AI suggestion, status SUGGESTED (as the pipeline leaves it)
    const case1 = await db.case.findUniqueOrThrow({ where: { caseId: CASE1 } });
    const docs = await db.caseDocument.findMany({ where: { caseId: case1.id, status: { not: "QUARANTINED" } }, orderBy: { documentId: "asc" }, take: 2 });
    const reviewer = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00001" } });
    // fixture hygiene: drop any previous run's identical fixture (unique pair)
    await db.aIRelationshipSuggestion.deleteMany({
      where: { sourceDocumentId: docs[0].id, targetDocumentId: docs[1].id, relationshipType: "RELATED" },
    });
    const sug = await db.aIRelationshipSuggestion.create({
      data: {
        caseRef: CASE1,
        sourceDocumentId: docs[0].id,
        sourceDocumentRef: docs[0].documentId,
        targetDocumentId: docs[1].id,
        targetDocumentRef: docs[1].documentId,
        relationshipType: "RELATED",
        confidence: 0.42,
        reason: "test fixture",
        status: "SUGGESTED",
      },
    });
    suggestedId = sug.id;

    // staleness FIRST: the fixture postdates the last (seed) sync
    await getStable(arjun, graphPath(CASE1));
    expect(arjun.data().staleness.stale).toBe(true);

    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    expect(arjun.lastStatus).toBe(200);
    await getStable(arjun, graphPath(CASE1));
    let refs = arjun.data().graph.edges.flatMap((e: any) => e.sourceRefs.map((r: any) => r.id));
    expect(refs).not.toContain(suggestedId); // THE gate: suggested ≠ fact
    // staleness cleared by that sync
    expect(arjun.data().staleness.stale).toBe(false);

    // human confirms it (what the Phase 5 review flow does)
    await db.aIRelationshipSuggestion.update({
      where: { id: suggestedId },
      data: { status: "CONFIRMED", reviewedByOfficerId: reviewer.id, reviewedAt: new Date() },
    });
    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    expect(arjun.lastStatus).toBe(200);
    await getStable(arjun, graphPath(CASE1));
    const edge = arjun.data().graph.edges.find((e: any) => e.sourceRefs.some((r: any) => r.id === suggestedId));
    expect(edge).toBeDefined();
    expect(edge.provenance).toBe("AI_CONFIRMED_RELATIONSHIP");
    expect(edge.confidence).toBeCloseTo(0.42);
    // staleness cleared by the sync
    expect(arjun.data().staleness.stale).toBe(false);
  });

  t("CONFIRMED entity match produces ONE normalized SAME_ENTITY edge (no merge)", async () => {
    // two VERIFIED entities of the same type on case 1
    const ents = await db.extractedEntity.findMany({ where: { caseRef: CASE1, reviewStatus: "VERIFIED" }, take: 2 });
    expect(ents.length).toBe(2);
    const reviewer = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00001" } });
    // fixture hygiene: drop any previous run's identical fixture (unique pair, both orderings)
    await db.entityCandidateMatch.deleteMany({
      where: { OR: [{ entityAId: ents[0].id, entityBId: ents[1].id }, { entityAId: ents[1].id, entityBId: ents[0].id }] },
    });
    const match = await db.entityCandidateMatch.create({
      data: {
        entityAId: ents[0].id,
        entityBId: ents[1].id,
        similarityScore: 0.9,
        matchReason: "test fixture",
        status: "CONFIRMED",
        reviewedByOfficerId: reviewer.id,
        reviewedAt: new Date(),
      },
    });
    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    await getStable(arjun, graphPath(CASE1));
    const edge = arjun.data().graph.edges.find((e: any) =>
      e.sourceRefs.some((r: any) => r.model === "EntityCandidateMatch" && r.id === match.id)
    );
    expect(edge).toBeDefined();
    expect(edge.edgeType).toBe("SAME_ENTITY");
    expect(edge.sourceKey < edge.targetKey).toBe(true); // normalized ordering
    expect(edge.confidence).toBeNull(); // human fact — no model confidence
  });

  t("rebuild is idempotent: same counts, same keys, bumped version", async () => {
    await getStable(arjun, graphPath(CASE1));
    const before = arjun.data();
    const keysBefore = before.graph.nodes.map((n: any) => n.nodeKey).sort();
    const edgeKeysBefore = before.graph.edges.map((e: any) => e.edgeKey).sort();
    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    await getStable(arjun, graphPath(CASE1));
    const after = arjun.data();
    expect(after.graph.nodes.map((n: any) => n.nodeKey).sort()).toEqual(keysBefore);
    expect(after.graph.edges.map((e: any) => e.edgeKey).sort()).toEqual(edgeKeysBefore);
    expect(after.sync.nodeCount).toBe(before.sync.nodeCount);
    expect(after.sync.edgeCount).toBe(before.sync.edgeCount);
    expect(after.sync.syncVersion).toBe(before.sync.syncVersion + 1);
  });

  t("QUARANTINED documents are never projected (security state)", async () => {
    const case1 = await db.case.findUniqueOrThrow({ where: { caseId: CASE1 } });
    const doc = await db.caseDocument.findFirstOrThrow({
      where: { caseId: case1.id, status: "COMMITTED", documentId: { endsWith: "000004" } },
    });
    const original = doc.status;
    await db.caseDocument.update({ where: { id: doc.id }, data: { status: "QUARANTINED" } });
    try {
      await postStable(arjun, `${graphPath(CASE1)}/sync`);
      await getStable(arjun, graphPath(CASE1));
      const keys = arjun.data().graph.nodes.map((n: any) => n.nodeKey);
      expect(keys).not.toContain(`DOC:${doc.documentId}`);
    } finally {
      await db.caseDocument.update({ where: { id: doc.id }, data: { status: original } });
      await postStable(arjun, `${graphPath(CASE1)}/sync`);
    }
  });
});

// ============================================================
// 4. Authorization & clearance
// ============================================================
describe("graph authorization & clearance", () => {
  let hrDocId: string;

  t("unrelated officer denied (403, audited), auditor sync denied by permission, unknown case 404, anonymous 401", async () => {
    await getStable(devika, graphPath(CASE1));
    expect(devika.lastStatus).toBe(403);
    expect(devika.code()).toBe("CASE_ACCESS_DENIED");
    await devika.post(`${graphPath(CASE1)}/sync`);
    expect(devika.lastStatus).toBe(403);

    await priya.post(`${graphPath(CASE1)}/sync`);
    expect(priya.lastStatus).toBe(403); // AUDITOR: read-only by policy

    await getStable(priya, graphPath(CASE1));
    expect(priya.lastStatus).toBe(200); // auditor CAN view

    await priya.get(graphPath("CASE-MP-IND-2026-999999"));
    expect(priya.lastStatus).toBe(404);

    const anon = new Client();
    await getStable(anon, graphPath(CASE1));
    expect(anon.lastStatus).toBe(401);

    const denied = await db.auditEvent.findFirst({
      where: { eventType: "GRAPH_ACCESS_DENIED", caseId: CASE1 },
      orderBy: { sequence: "desc" },
    });
    expect(denied).not.toBeNull();
  });

  t("HIGHLY_RESTRICTED node is invisible to clearance-3 auditor, visible to clearance-4 viewers — and so are its edges", async () => {
    hrDocId = (
      await uploadDocument(arjun, CASE1, {
        title: "Phase 6 clearance probe",
        type: "CASE_DIARY",
        classification: "HIGHLY_RESTRICTED",
        filename: "p6-clearance.txt",
        bytes: txtFile("Clearance probe for graph filtering. Reference: P6-PROBE-774."),
        description: "Uploaded by phase6 suite",
      })
    ).documentId;

    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    expect(arjun.lastStatus).toBe(200); // the rebuild itself must succeed
    const key = `DOC:${hrDocId}`;

    await getStable(sysadmin, graphPath(CASE1));
    expect(sysadmin.lastStatus).toBe(200);
    expect(sysadmin.data().graph.nodes.some((n: any) => n.nodeKey === key)).toBe(true);

    await getStable(arjun, graphPath(CASE1));
    expect(arjun.data().graph.nodes.some((n: any) => n.nodeKey === key)).toBe(true); // custodian admin: clearance 4

    await getStable(vishnu, graphPath(CASE1));
    expect(vishnu.lastStatus).toBe(200);
    expect(vishnu.data().graph.nodes.some((n: any) => n.nodeKey === key)).toBe(true); // assigned officer: clearance 4

    await getStable(priya, graphPath(CASE1));
    const priyaKeys = priya.data().graph.nodes.map((n: any) => n.nodeKey);
    expect(priyaKeys).not.toContain(key);
    // no surviving edge may touch the hidden node (no existence leak)
    const touching = priya.data().graph.edges.filter((e: any) => e.sourceKey === key || e.targetKey === key);
    expect(touching.length).toBe(0);
    expect(priya.data().viewer.droppedNodes).toBeGreaterThanOrEqual(1);
  });

  t("cross-case isolation: case 2's graph never bleeds into case 1", async () => {
    const doc2 = await uploadDocument(sysadmin, CASE2, {
      title: "Phase 6 cross-case probe",
      type: "CORRESPONDENCE",
      classification: "INTERNAL",
      filename: "p6-crosscase.txt",
      bytes: txtFile("Cross-case isolation probe P6-CROSS-774."),
    });
    await sysadmin.post(`${graphPath(CASE2)}/sync`);
    await getStable(arjun, graphPath(CASE1));
    const keys = arjun.data().graph.nodes.map((n: any) => n.nodeKey);
    expect(keys).not.toContain(`DOC:${doc2.documentId}`);
    expect(keys.every((k: string) => !k.startsWith("DOC:CASE-"))).toBe(true);
  });

  t("assigned officer may sync (case-manage); participant view-only officer may not", async () => {
    // vishnu: assigned LEAD_INVESTIGATOR, custodian dept → manage → sync OK
    await vishnu.post(`${graphPath(CASE1)}/sync`);
    expect(vishnu.lastStatus).toBe(200);
    // rohan: prosecution admin on case 1 — participant at most; case 1 has no prosecution custody
    const rohan = new Client();
    await rohan.login("rohan.verma@demo.gov.in");
    await postStable(rohan, `${graphPath(CASE1)}/sync`);
    expect([403, 200]).toContain(rohan.lastStatus); // depends on participation: manage only custodian-side
    // tighten: if prosecution is a mere participant, manage is false → 403
    const prosecutionParticipant = await db.caseDepartment.findFirst({
      where: { case: { caseId: CASE1 }, department: { departmentType: "PROSECUTION" }, status: "ACTIVE" },
    });
    if (prosecutionParticipant) expect(rohan.lastStatus).toBe(403);
  });
});

// ============================================================
// 5. Human relationships + audit integration + immutability
// ============================================================
describe("human relationships, audit chain, immutability", () => {
  t("creating a human document relationship then syncing yields a traceable HUMAN_RELATIONSHIP edge", async () => {
    const docs = await db.caseDocument.findMany({
      where: { case: { caseId: CASE1 }, status: "COMMITTED" },
      orderBy: { documentId: "asc" },
      take: 2,
    });
    const relStatus = await postStable(
      arjun,
      `/api/v1/cases/${CASE1}/documents/${docs[0].documentId}/relationships`,
      { targetDocumentId: docs[1].documentId, relationshipType: "RELATED" }
    );
    expect([201, 409]).toContain(relStatus); // 409 if seed already linked the pair
    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    await getStable(arjun, graphPath(CASE1));
    const edge = arjun.data().graph.edges.find(
      (e: any) =>
        e.provenance === "HUMAN_RELATIONSHIP" &&
        e.sourceKey === `DOC:${docs[0].documentId}` &&
        e.targetKey === `DOC:${docs[1].documentId}` &&
        e.relationshipType === "RELATED"
    );
    expect(edge).toBeDefined();
    expect(edge.confirmedByOfficerId).not.toBeNull();
    expect(edge.sourceRefs[0].model).toBe("DocumentRelationship");
  });

  t("GRAPH_* events are chained in the immutable audit ledger and the chain verifies VALID", async () => {
    const events = await db.auditEvent.findMany({
      where: { eventType: { in: ["GRAPH_SYNC_COMPLETED", "GRAPH_SYNC_FAILED", "GRAPH_VIEWED", "GRAPH_ACCESS_DENIED"] } },
      orderBy: { sequence: "asc" },
    });
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.eventType === "GRAPH_SYNC_COMPLETED" && e.caseId === CASE1)).toBe(true);
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.algorithm).toBe("SHA-256");
    // no secret-shaped metadata ever lands in graph events
    for (const e of events) {
      const raw = e.metadata ?? "";
      expect(raw.toLowerCase()).not.toContain("password");
      expect(raw.toLowerCase()).not.toContain("secret");
    }
  });

  t("sync never mutates central records: document hashes + evidence custody unchanged", async () => {
    const before = await db.caseDocument.findMany({
      where: { case: { caseId: CASE1 } },
      select: { documentId: true, sha256Hash: true, status: true, classification: true },
      orderBy: { documentId: "asc" },
    });
    const evBefore = await db.evidence.findMany({
      where: { case: { caseId: CASE1 } },
      select: { evidenceId: true, currentCustodianDepartmentId: true, currentCustodianOfficerId: true, status: true, sha256Hash: true },
      orderBy: { evidenceId: "asc" },
    });
    await postStable(arjun, `${graphPath(CASE1)}/sync`);
    const after = await db.caseDocument.findMany({
      where: { case: { caseId: CASE1 } },
      select: { documentId: true, sha256Hash: true, status: true, classification: true },
      orderBy: { documentId: "asc" },
    });
    const evAfter = await db.evidence.findMany({
      where: { case: { caseId: CASE1 } },
      select: { evidenceId: true, currentCustodianDepartmentId: true, currentCustodianOfficerId: true, status: true, sha256Hash: true },
      orderBy: { evidenceId: "asc" },
    });
    expect(after).toEqual(before);
    expect(evAfter).toEqual(evBefore);
  });

  t("meta exposes graph registries", async () => {
    await arjun.get("/api/v1/meta");
    expect(arjun.lastStatus).toBe(200);
    const m = arjun.data();
    expect(m.graphNodeTypes).toContain("ENTITY");
    expect(m.graphEdgeTypes).toContain("SAME_ENTITY");
    expect(m.graphEdgeProvenance).toContain("AI_CONFIRMED_RELATIONSHIP");
    expect(m.graphAuditEventTypes).toContain("GRAPH_SYNC_COMPLETED");
  });
});
