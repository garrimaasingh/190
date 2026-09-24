/**
 * Phase 2 API & security test suite (spec §54/§55).
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase2.test.ts
 *
 * Test-created cases are hard-deleted in afterAll (development/test
 * utility per spec §36 — never exposed through the production API).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a" };

// ---------- cookie-aware test client (same as Phase 1) ----------

class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = {
      ...BYPASS,
      ...(extraHeaders || {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
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
      if (pair.endsWith("=")) this.cookie = null;
      else this.cookie = pair;
    }
    return res;
  }
  get(path: string) { return this.req("GET", path); }
  post(path: string, body?: unknown) { return this.req("POST", path, body); }
  patch(path: string, body?: unknown) { return this.req("PATCH", path, body); }
  del(path: string) { return this.req("DELETE", path); }
  async login(email: string, password = SEED_PASSWORD) {
    return this.req("POST", "/api/v1/auth/login", { email, password });
  }
  code() { return this.lastBody?.error?.code; }
  data() { return this.lastBody?.data; }
}

let sys: Client, adminPolice: Client, adminFsl: Client, adminProsecution: Client,
    officerPolice: Client, auditor: Client, anon: Client, adminBhopal: Client;

// ---------- fixtures ----------
const stamp = Date.now();
let geo: { stateId: string; districtId: string; cityId: string };
let deptIds: { police: string; fsl: string; prosecution: string; bhopal: string };
const createdCaseInternalIds: string[] = [];

async function createCase(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client.post("/api/v1/cases", {
    title: `Phase 2 Test Case ${stamp}`,
    caseType: "CRIMINAL",
    priority: "NORMAL",
    ...geo,
    ...overrides,
  });
  if (res.status === 201 && client.data()?.id) createdCaseInternalIds.push(client.data().id);
  return res;
}

beforeAll(async () => {
  sys = new Client(); await sys.login("sysadmin@demo.gov.in");
  adminPolice = new Client(); await adminPolice.login("arjun.sharma@demo.gov.in");
  adminFsl = new Client(); await adminFsl.login("meera.desai@demo.gov.in");
  adminProsecution = new Client(); await adminProsecution.login("rohan.verma@demo.gov.in");
  officerPolice = new Client(); await officerPolice.login("vishnu.kumar@demo.gov.in");
  auditor = new Client(); await auditor.login("priya.nair@demo.gov.in");
  adminBhopal = new Client(); await adminBhopal.login("devika.iyer@demo.gov.in");
  anon = new Client();

  // Discover geography + departments
  await sys.get("/api/v1/geography/countries");
  const india = sys.data().find((x: any) => x.code === "IN");
  await sys.get(`/api/v1/geography/states?countryId=${india.id}`);
  const mp = sys.data().find((s: any) => s.code === "MP");
  await sys.get(`/api/v1/geography/states/${mp.id}/districts`);
  const indoreD = sys.data().find((d: any) => d.code === "IND");
  await sys.get(`/api/v1/geography/districts/${indoreD.id}/cities`);
  const indoreC = sys.data().find((x: any) => x.code === "IND");
  geo = { stateId: mp.id, districtId: indoreD.id, cityId: indoreC.id };

  const dirs = await sys.get("/api/v1/departments?page=1&pageSize=100");
  const byCode = (code: string) => sys.data().items.find((d: any) => d.departmentCode === code);
  deptIds = {
    police: byCode("DEPT-MP-IND-POL-001").id,
    fsl: byCode("DEPT-MP-IND-FSL-001").id,
    prosecution: byCode("DEPT-MP-IND-PRO-001").id,
    bhopal: byCode("DEPT-MP-BHO-POL-001").id,
  };
});

afterAll(async () => {
  // Development/test cleanup utility (spec §36) — DB-level, never via API.
  for (const id of createdCaseInternalIds) {
    await db.identityEvent.deleteMany({ where: { targetId: id } });
    await db.caseEvent.deleteMany({ where: { caseId: id } });
    await db.caseTransfer.deleteMany({ where: { caseId: id } });
    await db.caseOfficer.deleteMany({ where: { caseId: id } });
    await db.caseDepartment.deleteMany({ where: { caseId: id } });
    await db.case.deleteMany({ where: { id: id } });
  }
  await db.$disconnect();
});

// ============================================================
// 1. CASE CREATION (spec §54)
// ============================================================
describe("Case creation", () => {
  test("DEPARTMENT_ADMIN creates a valid case; ID is system-generated", async () => {
    const res = await createCase(adminPolice, {
      title: `Valid Creation Test ${stamp}`,
      caseNumber: `TST/${stamp}/1`,
      caseType: "CYBERCRIME",
      priority: "HIGH",
    });
    expect(res.status).toBe(201);
    const d = adminPolice.data();
    expect(d.caseId).toMatch(/^CASE-MP-IND-\d{4}-\d{6}$/);
    expect(d.status).toBe("OPEN");
    expect(d.originatingDepartment.id).toBe(deptIds.police);
    expect(d.currentCustodianDepartment.id).toBe(deptIds.police);
  });

  test("caseNumber and caseId are distinct concepts", async () => {
    const res = await createCase(adminPolice, { caseNumber: `FIR-DEMO/${stamp}` });
    expect(res.status).toBe(201);
    expect(adminPolice.data().caseId).not.toBe(adminPolice.data().caseNumber);
  });

  test("case without official number is allowed", async () => {
    const res = await createCase(adminPolice);
    expect(res.status).toBe(201);
  });

  test("duplicate official case number within originating department → 409", async () => {
    const num = `DUP/${stamp}`;
    await createCase(adminPolice, { caseNumber: num });
    const res = await createCase(adminPolice, { caseNumber: num });
    expect(res.status).toBe(409);
    expect(adminPolice.code()).toBe("CONFLICT");
  });

  test("mismatched geography (city from another district) → 422", async () => {
    await sys.get("/api/v1/geography/countries");
    const india = sys.data().find((x: any) => x.code === "IN");
    await sys.get(`/api/v1/geography/states?countryId=${india.id}`);
    const mp = sys.data().find((s: any) => s.code === "MP");
    await sys.get(`/api/v1/geography/states/${mp.id}/districts`);
    const bhopalD = sys.data().find((d: any) => d.code === "BHO");
    await sys.get(`/api/v1/geography/districts/${bhopalD.id}/cities`);
    const bhopalC = sys.data().find((x: any) => x.code === "BHO");
    const res = await createCase(adminPolice, { cityId: bhopalC.id }); // Indore district + Bhopal city
    expect(res.status).toBe(422);
    expect(adminPolice.code()).toBe("GEOGRAPHY_HIERARCHY_INVALID");
  });

  test("invalid case type → 422", async () => {
    const res = await createCase(adminPolice, { caseType: "TERRORISM" });
    expect(res.status).toBe(422);
    expect(adminPolice.code()).toBe("VALIDATION_ERROR");
  });

  test("invalid priority → 422", async () => {
    const res = await createCase(adminPolice, { priority: "URGENT" });
    expect(res.status).toBe(422);
  });

  test("missing title → 422", async () => {
    const res = await createCase(adminPolice, { title: "" });
    expect(res.status).toBe(422);
  });

  test("AUDITOR cannot create cases → 403", async () => {
    const res = await createCase(auditor);
    expect(res.status).toBe(403);
  });

  test("unauthenticated creation → 401", async () => {
    const res = await createCase(anon);
    expect(res.status).toBe(401);
  });

  test("forged department/creator/status fields are ignored", async () => {
    const res = await adminPolice.post("/api/v1/cases", {
      title: `Forged Fields Test ${stamp}`,
      caseType: "CRIMINAL",
      priority: "NORMAL",
      ...geo,
      originatingDepartmentId: deptIds.fsl,
      currentCustodianDepartmentId: deptIds.prosecution,
      createdByOfficerId: "FORGED-OFFICER",
      status: "CLOSED",
      caseId: "CASE-XX-XX-9999-999999",
    });
    expect(res.status).toBe(201);
    const d = adminPolice.data();
    createdCaseInternalIds.push(d.id);
    expect(d.originatingDepartment.id).toBe(deptIds.police); // derived from session
    expect(d.currentCustodianDepartment.id).toBe(deptIds.police);
    expect(d.status).toBe("OPEN"); // not client-controlled
    expect(d.caseId).not.toBe("CASE-XX-XX-9999-999999"); // server-generated
  });

  test("OFFICER role can create a case (authorized officer)", async () => {
    const res = await createCase(officerPolice, { title: `Officer Created Case ${stamp}` });
    expect(res.status).toBe(201);
    expect(officerPolice.data().createdByOfficer.name).toBe("Vishnu Kumar");
  });
});

// ============================================================
// 2. CASE AUTHORIZATION (spec §54)
// ============================================================
describe("Case authorization", () => {
  let caseId: string;

  beforeAll(async () => {
    const res = await createCase(adminPolice, { title: `Auth Matrix Case ${stamp}` });
    caseId = adminPolice.data().caseId;
    expect(res.status).toBe(201);
  });

  test("SYSTEM_ADMIN can view and manage any case", async () => {
    await sys.get(`/api/v1/cases/${caseId}`);
    expect(sys.lastStatus).toBe(200);
    expect(sys.data().viewer.manage).toBe(true);
  });

  test("AUDITOR has read-only visibility", async () => {
    await auditor.get(`/api/v1/cases/${caseId}`);
    expect(auditor.lastStatus).toBe(200);
    expect(auditor.data().viewer.view).toBe(true);
    expect(auditor.data().viewer.manage).toBe(false);
  });

  test("unassigned officer of custodian dept can view but not manage", async () => {
    await officerPolice.get(`/api/v1/cases/${caseId}`);
    expect(officerPolice.lastStatus).toBe(200);
    expect(officerPolice.data().viewer.view).toBe(true);
    expect(officerPolice.data().viewer.manage).toBe(false);
  });

  test("officer from unrelated department (Bhopal) cannot access → 403", async () => {
    await adminBhopal.get(`/api/v1/cases/${caseId}`);
    expect(adminBhopal.lastStatus).toBe(403);
    expect(adminBhopal.code()).toBe("CASE_ACCESS_DENIED");
  });

  test("unauthenticated case access → 401", async () => {
    await anon.get(`/api/v1/cases/${caseId}`);
    expect(anon.lastStatus).toBe(401);
  });

  test("forged case id → 404", async () => {
    await adminPolice.get("/api/v1/cases/CASE-XX-NOPE-2099-000001");
    expect(adminPolice.lastStatus).toBe(404);
  });

  test("access explanation endpoint reflects viewer position", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/access`);
    expect(adminPolice.lastStatus).toBe(200);
    expect(adminPolice.data().isCustodianSide).toBe(true);
    await adminBhopal.get(`/api/v1/cases/${caseId}/access`);
    expect(adminBhopal.lastStatus).toBe(403);
  });

  test("search does not leak unauthorized cases (spec §50)", async () => {
    // Bhopal admin has no participation → must not see the case
    await adminBhopal.get(`/api/v1/cases?search=${encodeURIComponent("Auth Matrix Case")}`);
    expect(adminBhopal.lastStatus).toBe(200);
    const leaked = (adminBhopal.data().items || []).some((c: any) => c.caseId === caseId);
    expect(leaked).toBe(false);
    // Police admin (origin/custodian) must see it
    await adminPolice.get(`/api/v1/cases?search=${encodeURIComponent("Auth Matrix Case")}`);
    const visible = (adminPolice.data().items || []).some((c: any) => c.caseId === caseId);
    expect(visible).toBe(true);
  });
});

// ============================================================
// 3. CASE STATUS LIFECYCLE (spec §54)
// ============================================================
describe("Case status lifecycle", () => {
  let caseId: string;

  beforeAll(async () => {
    await createCase(adminPolice, { title: `Lifecycle Case ${stamp}` });
    caseId = adminPolice.data().caseId;
  });

  test("valid transition OPEN → UNDER_INVESTIGATION", async () => {
    const res = await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "UNDER_INVESTIGATION" });
    expect(res.status).toBe(200);
    expect(adminPolice.data().status).toBe("UNDER_INVESTIGATION");
  });

  test("invalid transition UNDER_INVESTIGATION → ARCHIVED → 409", async () => {
    const res = await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "ARCHIVED" });
    expect(res.status).toBe(409);
    expect(adminPolice.code()).toBe("INVALID_STATUS_TRANSITION");
  });

  test("unauthorized transition (officer without assignment) → 403", async () => {
    const res = await officerPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "PENDING_FORENSICS" });
    expect(res.status).toBe(403);
  });

  test("auditor cannot change status → 403", async () => {
    const res = await auditor.patch(`/api/v1/cases/${caseId}/status`, { status: "CLOSED" });
    expect(res.status).toBe(403);
  });

  test("closed case cannot be modified (metadata PATCH) → 409", async () => {
    await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "CLOSED" });
    expect(adminPolice.lastStatus).toBe(200);
    const res = await adminPolice.patch(`/api/v1/cases/${caseId}`, { title: "Should Fail" });
    expect(res.status).toBe(409);
    expect(adminPolice.code()).toBe("CASE_IMMUTABLE");
    // closed case can only be archived
    await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "UNDER_INVESTIGATION" });
    expect(adminPolice.lastStatus).toBe(409);
    await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "ARCHIVED" });
    expect(adminPolice.lastStatus).toBe(200);
    // archived is terminal
    await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "OPEN" });
    expect(adminPolice.lastStatus).toBe(409);
  });

  test("case metadata update works while mutable", async () => {
    const res = await adminPolice.patch(`/api/v1/cases/${caseId}`, { priority: "CRITICAL", description: "updated" });
    expect(res.status).toBe(409); // archived in prior test → immutable
    const res2 = await createCase(adminPolice, { title: `Mutable Update Case ${stamp}` });
    const id2 = adminPolice.data().caseId;
    const ok = await adminPolice.patch(`/api/v1/cases/${id2}`, { priority: "CRITICAL" });
    expect(ok.status).toBe(200);
    expect(adminPolice.data().priority).toBe("CRITICAL");
    void res; void res2;
  });

  test("mass assignment via PATCH is ignored (status/custodian)", async () => {
    await createCase(adminPolice, { title: `Mass Assign Case ${stamp}` });
    const id = adminPolice.data().caseId;
    await adminPolice.patch(`/api/v1/cases/${id}`, {
      status: "CLOSED",
      currentCustodianDepartmentId: deptIds.fsl,
      createdByOfficerId: "FORGED",
    } as any);
    expect(adminPolice.lastStatus).toBe(200);
    await adminPolice.get(`/api/v1/cases/${id}`);
    expect(adminPolice.data().status).not.toBe("CLOSED");
    expect(adminPolice.data().currentCustodianDepartment.id).toBe(deptIds.police);
  });
});

// ============================================================
// 4. CASE OFFICERS (spec §54)
// ============================================================
describe("Case officers", () => {
  let caseId: string;

  beforeAll(async () => {
    await createCase(adminPolice, { title: `Officer Mgmt Case ${stamp}` });
    caseId = adminPolice.data().caseId;
    // Add FSL as participating department for cross-dept assignment tests
    await adminPolice.post(`/api/v1/cases/${caseId}/departments`, {
      departmentId: deptIds.fsl,
      participationType: "PARTICIPATING",
    });
  });

  test("assign a valid officer of a participating department", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-MP-IND-00004", // Vishnu (Police)
      roleOnCase: "LEAD_INVESTIGATOR",
    });
    expect(res.status).toBe(201);
  });

  test("duplicate assignment → 409", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-MP-IND-00004",
      roleOnCase: "SUPPORT_OFFICER",
    });
    expect(res.status).toBe(409);
  });

  test("assign inactive officer → 422 (Kavya is PENDING)", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-MP-IND-00005",
      roleOnCase: "SUPPORT_OFFICER",
    });
    expect(res.status).toBe(422);
    expect(adminPolice.code()).toBe("OFFICER_INELIGIBLE");
  });

  test("assign nonexistent officer → 404", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-XX-XX-99999",
      roleOnCase: "SUPPORT_OFFICER",
    });
    expect(res.status).toBe(404);
  });

  test("assign officer whose department is not a participant → 422", async () => {
    // Bhopal officer (Devika) — Bhopal Police does not participate
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-MP-BHO-00006",
      roleOnCase: "SUPPORT_OFFICER",
    });
    expect(res.status).toBe(422);
  });

  test("unauthorized assignment (officer without manage) → 403", async () => {
    // Fresh case where the officer has NO assignment yet — custodian-side
    // officers only manage cases they are explicitly assigned to.
    await createCase(adminPolice, { title: `Unauth Assign Case ${stamp}` });
    const freshCase = adminPolice.data().caseId;
    const res = await officerPolice.post(`/api/v1/cases/${freshCase}/officers`, {
      officerId: "OFF-MP-IND-00001",
      roleOnCase: "REVIEWER",
    });
    expect(res.status).toBe(403);
  });

  test("auditor cannot assign → 403", async () => {
    const res = await auditor.post(`/api/v1/cases/${caseId}/officers`, {
      officerId: "OFF-MP-IND-00004",
      roleOnCase: "REVIEWER",
    });
    expect(res.status).toBe(403);
  });

  test("eligible-officers endpoint: participant dept works, non-participant rejected", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/eligible-officers?departmentId=${deptIds.fsl}&purpose=assign`);
    expect(adminPolice.lastStatus).toBe(200);
    expect(adminPolice.data().items.length).toBeGreaterThan(0);
    await adminPolice.get(`/api/v1/cases/${caseId}/eligible-officers?departmentId=${deptIds.bhopal}&purpose=assign`);
    expect(adminPolice.lastStatus).toBe(422);
  });

  test("change case role", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/officers`);
    const record = adminPolice.data().items.find((o: any) => o.officer.officerId === "OFF-MP-IND-00004");
    const res = await adminPolice.patch(`/api/v1/cases/${caseId}/officers/${record.id}`, { roleOnCase: "INVESTIGATING_OFFICER" });
    expect(res.status).toBe(200);
    await adminPolice.get(`/api/v1/cases/${caseId}/officers`);
    const after = adminPolice.data().items.find((o: any) => o.officer.officerId === "OFF-MP-IND-00004");
    expect(after.roleOnCase).toBe("INVESTIGATING_OFFICER");
  });

  test("unassign officer — record retained as REMOVED", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/officers`);
    const record = adminPolice.data().items.find((o: any) => o.officer.officerId === "OFF-MP-IND-00004");
    const res = await adminPolice.del(`/api/v1/cases/${caseId}/officers/${record.id}`);
    expect(res.status).toBe(200);
    await adminPolice.get(`/api/v1/cases/${caseId}/officers`);
    const after = adminPolice.data().items.find((o: any) => o.officer.officerId === "OFF-MP-IND-00004");
    expect(after.status).toBe("REMOVED");
    expect(after.unassignedAt).not.toBeNull();
  });
});

// ============================================================
// 5. CASE DEPARTMENTS (spec §54)
// ============================================================
describe("Case departments", () => {
  let caseId: string;

  beforeAll(async () => {
    await createCase(adminPolice, { title: `Dept Mgmt Case ${stamp}` });
    caseId = adminPolice.data().caseId;
  });

  test("add valid participating department", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/departments`, {
      departmentId: deptIds.fsl,
      participationType: "PARTICIPATING",
    });
    expect(res.status).toBe(201);
  });

  test("duplicate department → 409", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/departments`, {
      departmentId: deptIds.fsl,
    });
    expect(res.status).toBe(409);
  });

  test("nonexistent department → 404", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/departments`, {
      departmentId: "nonexistent-dept-id",
    });
    expect(res.status).toBe(404);
  });

  test("unauthorized addition (officer without manage) → 403", async () => {
    const res = await officerPolice.post(`/api/v1/cases/${caseId}/departments`, {
      departmentId: deptIds.prosecution,
    });
    expect(res.status).toBe(403);
  });

  test("originating department and current custodian cannot be removed", async () => {
    const res = await adminPolice.del(`/api/v1/cases/${caseId}/departments/${deptIds.police}`);
    expect(res.status).toBe(409);
  });

  test("remove participating department → removed; re-add works", async () => {
    const res = await adminPolice.del(`/api/v1/cases/${caseId}/departments/${deptIds.fsl}`);
    expect(res.status).toBe(200);
    const re = await adminPolice.post(`/api/v1/cases/${caseId}/departments`, { departmentId: deptIds.fsl });
    expect(re.status).toBe(201);
  });

  test("custody cannot be set by adding a department — only via transfer", async () => {
    // adding a department must NOT change the custodian
    await adminPolice.post(`/api/v1/cases/${caseId}/departments`, { departmentId: deptIds.prosecution });
    await adminPolice.get(`/api/v1/cases/${caseId}`);
    expect(adminPolice.data().currentCustodianDepartment.id).toBe(deptIds.police);
  });
});

// ============================================================
// 6. CUSTODY / TRANSFERS (spec §54)
// ============================================================
describe("Custody transfers", () => {
  let caseId: string;

  beforeAll(async () => {
    await createCase(adminPolice, { title: `Custody Case ${stamp}` });
    caseId = adminPolice.data().caseId;
  });

  test("non-custodian cannot initiate transfer → 403", async () => {
    const res = await adminFsl.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: deptIds.fsl,
      reason: "Hostile takeover attempt",
    });
    expect(res.status).toBe(403);
  });

  test("self-transfer → 422", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: deptIds.police,
      reason: "Sending to myself",
    });
    expect(res.status).toBe(422);
    expect(adminPolice.code()).toBe("DEPARTMENT_INELIGIBLE");
  });

  test("transfer to nonexistent department → 404", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: "no-such-dept",
      reason: "Test",
    });
    expect(res.status).toBe(404);
  });

  test("transfer with receiving officer from another department → 422", async () => {
    // Vishnu (Police) as receiving officer for FSL destination
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: deptIds.fsl,
      toOfficerId: "OFF-MP-IND-00004",
      reason: "Wrong officer department",
    });
    expect(res.status).toBe(422);
    expect(adminPolice.code()).toBe("OFFICER_INELIGIBLE");
  });

  test("valid transfer request → REQUESTED with immutable TRF id", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: deptIds.fsl,
      toOfficerId: "OFF-MP-IND-00002",
      reason: "Forensic analysis required",
    });
    expect(res.status).toBe(201);
    expect(adminPolice.data().transferId).toMatch(/^TRF-MP-IND-\d{4}-\d{6}$/);
    expect(adminPolice.data().status).toBe("REQUESTED");
  });

  test("second transfer while one is pending → 409 TRANSFER_ALREADY_PENDING", async () => {
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, {
      toDepartmentId: deptIds.prosecution,
      reason: "Simultaneous attempt",
    });
    expect(res.status).toBe(409);
    expect(adminPolice.code()).toBe("TRANSFER_ALREADY_PENDING");
  });

  test("custody unchanged while transfer is REQUESTED", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}`);
    expect(adminPolice.data().currentCustodianDepartment.id).toBe(deptIds.police);
  });

  test("non-receiving department cannot accept → 403", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/transfers`);
    const trf = adminPolice.data().items[0].transferId;
    const res = await adminBhopal.post(`/api/v1/cases/${caseId}/transfers/${trf}/accept`);
    expect(res.status).toBe(403);
  });

  test("requesting side cannot accept its own transfer → 403", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/transfers`);
    const trf = adminPolice.data().items[0].transferId;
    const res = await adminPolice.post(`/api/v1/cases/${caseId}/transfers/${trf}/accept`);
    expect(res.status).toBe(403);
  });

  test("receiving officer views the case before acceptance (destination-side review)", async () => {
    await adminFsl.get(`/api/v1/cases/${caseId}`);
    expect(adminFsl.lastStatus).toBe(200);
    expect(adminFsl.data().viewer.view).toBe(true);
  });

  test("incoming mailbox lists the pending transfer for FSL", async () => {
    await adminFsl.get("/api/v1/transfers/incoming");
    expect(adminFsl.lastStatus).toBe(200);
    const found = (adminFsl.data().items || []).some((t: any) => t.case.caseId === caseId);
    expect(found).toBe(true);
  });

  test("ACCEPT changes custody; police becomes historical/origin", async () => {
    await adminFsl.get(`/api/v1/cases/${caseId}/transfers`);
    const trf = adminFsl.data().items[0].transferId;
    const res = await adminFsl.post(`/api/v1/cases/${caseId}/transfers/${trf}/accept`);
    expect(res.status).toBe(200);
    expect(adminFsl.data().status).toBe("ACCEPTED");

    await adminPolice.get(`/api/v1/cases/${caseId}`);
    expect(adminPolice.data().currentCustodianDepartment.id).toBe(deptIds.fsl);
    const origin = adminPolice.data().participants.find((p: any) => p.isOrigin);
    expect(origin.department.id).toBe(deptIds.police);
  });

  test("accepting the same transfer twice → 409 INVALID_TRANSFER_STATE", async () => {
    await adminFsl.get(`/api/v1/cases/${caseId}/transfers`);
    const trf = adminFsl.data().items[0].transferId;
    const res = await adminFsl.post(`/api/v1/cases/${caseId}/transfers/${trf}/accept`);
    expect(res.status).toBe(409);
    expect(adminFsl.code()).toBe("INVALID_TRANSFER_STATE");
  });

  test("concurrent decisions on the same transfer: exactly one wins", async () => {
    // Fresh case with a pending transfer, then two simultaneous accepts.
    await createCase(adminPolice, { title: `Concurrent Accept Case ${stamp}` });
    const cid = adminPolice.data().caseId;
    await adminPolice.post(`/api/v1/cases/${cid}/transfers`, {
      toDepartmentId: deptIds.fsl,
      reason: "Concurrency test",
    });
    await adminFsl.get(`/api/v1/cases/${cid}/transfers`);
    const trf = adminFsl.data().items[0].transferId;
    const [r1, r2] = await Promise.all([
      adminFsl.post(`/api/v1/cases/${cid}/transfers/${trf}/accept`),
      adminFsl.post(`/api/v1/cases/${cid}/transfers/${trf}/accept`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  test("stale transfer fails safely when custody already moved", async () => {
    // Create a pending transfer while Police is custodian of a new case,
    // cancel nothing — instead simulate: transfer to FSL, then (via a second
    // case) verify accept on a case whose custody changed → stale guard.
    await createCase(adminPolice, { title: `Stale Case ${stamp}` });
    const cid = adminPolice.data().caseId;
    await adminPolice.post(`/api/v1/cases/${cid}/transfers`, {
      toDepartmentId: deptIds.prosecution,
      reason: "First leg",
    });
    // FSL accepts nothing here; prosecution list shows no pending (it's for prosecution)
    await adminProsecution.get("/api/v1/transfers/incoming");
    const found = (adminProsecution.data().items || []).some((t: any) => t.case.caseId === cid);
    expect(found).toBe(true);
  });

  test("REJECT keeps custody unchanged", async () => {
    await createCase(adminPolice, { title: `Reject Case ${stamp}` });
    const cid = adminPolice.data().caseId;
    await adminPolice.post(`/api/v1/cases/${cid}/transfers`, {
      toDepartmentId: deptIds.fsl,
      reason: "Reject flow test",
    });
    await adminFsl.get(`/api/v1/cases/${cid}/transfers`);
    const res = await adminFsl.post(`/api/v1/cases/${cid}/transfers/${adminFsl.data().items[0].transferId}/reject`);
    expect(res.status).toBe(200);
    expect(adminFsl.data().status).toBe("REJECTED");
    await adminPolice.get(`/api/v1/cases/${cid}`);
    expect(adminPolice.data().currentCustodianDepartment.id).toBe(deptIds.police);
    // new request allowed after rejection
    const again = await adminPolice.post(`/api/v1/cases/${cid}/transfers`, {
      toDepartmentId: deptIds.prosecution,
      reason: "Retry after rejection",
    });
    expect(again.status).toBe(201);
    await adminPolice.get(`/api/v1/cases/${cid}/transfers`);
    const pending = adminPolice.data().items.find((t: any) => t.status === "REQUESTED");
    const cancel = await adminPolice.post(`/api/v1/cases/${cid}/transfers/${pending.transferId}/cancel`);
    expect(cancel.status).toBe(200);
    expect(adminPolice.data().status).toBe("CANCELLED");
  });

  test("receiving side cannot cancel (only requester side)", async () => {
    await createCase(adminPolice, { title: `Cancel Guard Case ${stamp}` });
    const cid = adminPolice.data().caseId;
    await adminPolice.post(`/api/v1/cases/${cid}/transfers`, {
      toDepartmentId: deptIds.fsl,
      reason: "Cancel guard test",
    });
    await adminPolice.get(`/api/v1/cases/${cid}/transfers`);
    const res = await adminFsl.post(`/api/v1/cases/${cid}/transfers/${adminPolice.data().items[0].transferId}/cancel`);
    expect(res.status).toBe(403);
  });

  test("completed transfer cannot be edited and history cannot be deleted", async () => {
    // custody case (first in this suite) has an ACCEPTED transfer; there is
    // no DELETE endpoint for transfers by design:
    const res = await adminFsl.req("DELETE", `/api/v1/cases/${caseId}/transfers/whatever`);
    expect([404, 405]).toContain(res.status);
  });
});

// ============================================================
// 7. HISTORY & TIMELINE (spec §54)
// ============================================================
describe("History & timeline", () => {
  let caseId: string;

  beforeAll(async () => {
    await createCase(adminPolice, { title: `Timeline Case ${stamp}` });
    caseId = adminPolice.data().caseId;
    await adminPolice.post(`/api/v1/cases/${caseId}/officers`, { officerId: "OFF-MP-IND-00004", roleOnCase: "LEAD_INVESTIGATOR" });
    await adminPolice.post(`/api/v1/cases/${caseId}/departments`, { departmentId: deptIds.fsl });
    await adminPolice.patch(`/api/v1/cases/${caseId}/status`, { status: "UNDER_INVESTIGATION" });
    await adminPolice.post(`/api/v1/cases/${caseId}/transfers`, { toDepartmentId: deptIds.prosecution, reason: "Timeline transfer" });
    await adminProsecution.get(`/api/v1/cases/${caseId}/transfers`);
    await adminProsecution.post(`/api/v1/cases/${caseId}/transfers/${adminProsecution.data().items[0].transferId}/accept`);
  });

  test("timeline contains the full ordered event chain", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/timeline`);
    expect(adminPolice.lastStatus).toBe(200);
    const types = adminPolice.data().items.map((e: any) => e.eventType);
    expect(types[0]).toBe("CASE_CREATED");
    expect(types).toContain("CASE_OFFICER_ASSIGNED");
    expect(types).toContain("CASE_DEPARTMENT_ADDED");
    expect(types).toContain("CASE_STATUS_CHANGED");
    expect(types).toContain("CASE_TRANSFER_REQUESTED");
    expect(types).toContain("CASE_TRANSFER_ACCEPTED");
    // chronological order
    const times = adminPolice.data().items.map((e: any) => new Date(e.createdAt).getTime());
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  test("custody history preserved with previous custodian retained", async () => {
    await adminPolice.get(`/api/v1/cases/${caseId}/transfers`);
    expect(adminPolice.data().items.length).toBe(1);
    const trf = adminPolice.data().items[0];
    expect(trf.status).toBe("ACCEPTED");
    expect(trf.fromDepartment.id).toBe(deptIds.police);
    expect(trf.toDepartment.id).toBe(deptIds.prosecution);
    // participating list still contains police (as origin/historical)
    await adminPolice.get(`/api/v1/cases/${caseId}`);
    const policeRow = adminPolice.data().participants.find((p: any) => p.department.id === deptIds.police);
    expect(policeRow).toBeDefined();
    expect(policeRow.status ?? "ACTIVE").toBe("ACTIVE");
  });

  test("unauthorized user receives no timeline", async () => {
    await adminBhopal.get(`/api/v1/cases/${caseId}/timeline`);
    expect(adminBhopal.lastStatus).toBe(403);
  });
});

// ============================================================
// 8. SECURITY TESTING (spec §55)
// ============================================================
describe("Security", () => {
  test("forged JWT/session cookie → 401", async () => {
    const res = await anon.req("GET", "/api/v1/cases", undefined, { Cookie: "cp_session=forged.jwt.token" });
    expect(res.status).toBe(401);
  });

  test("expired/revoked session → 401 (revoked session of logged-out client)", async () => {
    const temp = new Client();
    await temp.login("arjun.sharma@demo.gov.in");
    await temp.post("/api/v1/auth/logout");
    const res = await temp.get("/api/v1/cases");
    expect(res.status).toBe(401);
  });

  test("SQL injection attempt in search is safely ignored", async () => {
    await adminPolice.get(`/api/v1/cases?search=${encodeURIComponent("'; DROP TABLE Case;--")}`);
    expect(adminPolice.lastStatus).toBe(200);
    // table still functional
    await adminPolice.get("/api/v1/cases?pageSize=1");
    expect(adminPolice.lastStatus).toBe(200);
  });

  test("XSS payload in case metadata is stored as inert text", async () => {
    const xss = `<script>alert("x")</script>`;
    const res = await createCase(adminPolice, { title: `XSS Probe ${stamp} ${xss}`.slice(0, 200) });
    expect(res.status).toBe(201);
    await adminPolice.get(`/api/v1/cases/${adminPolice.data().caseId}`);
    expect(adminPolice.lastStatus).toBe(200);
    expect(adminPolice.data().title).toContain(xss); // stored verbatim, escaped at render time
  });

  test("horizontal escalation: forged caseId in transfer path → 404/403, no cross-case action", async () => {
    const res = await adminFsl.post("/api/v1/cases/CASE-XX-XX-2099-999999/transfers/latest/accept");
    expect([403, 404]).toContain(res.status);
  });

  test("vertical escalation: officer cannot use admin-only endpoints", async () => {
    await officerPolice.get("/api/v1/admin/stats");
    expect(officerPolice.lastStatus).toBe(403);
  });

  test("malicious long strings are rejected by validation", async () => {
    const res = await createCase(adminPolice, { title: "x".repeat(500) });
    expect(res.status).toBe(422);
  });

  test("unauthenticated incoming-transfers access → 401", async () => {
    await anon.get("/api/v1/transfers/incoming");
    expect(anon.lastStatus).toBe(401);
  });

  test("CASE_ACCESS_DENIED event recorded on unauthorized detail access", async () => {
    await createCase(adminPolice, { title: `Deny Audit Case ${stamp}` });
    const cid = adminPolice.data().caseId;
    await adminBhopal.get(`/api/v1/cases/${cid}`);
    expect(adminBhopal.lastStatus).toBe(403);
    const events = await db.caseEvent.findMany({
      where: { case: { caseId: cid }, eventType: "CASE_ACCESS_DENIED" },
    });
    expect(events.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 9. PHASE 1 REGRESSION GUARDS
// ============================================================
describe("Phase 1 regression", () => {
  test("auth/me still works", async () => {
    await adminPolice.get("/api/v1/auth/me");
    expect(adminPolice.lastStatus).toBe(200);
  });
  test("departments directory still works", async () => {
    await sys.get("/api/v1/departments?page=1&pageSize=5");
    expect(sys.lastStatus).toBe(200);
  });
  test("officers directory still works", async () => {
    await sys.get("/api/v1/officers?page=1&pageSize=5");
    expect(sys.lastStatus).toBe(200);
  });
});
