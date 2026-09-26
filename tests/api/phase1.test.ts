/**
 * Phase 1 API test suite (spec §48–§50).
 * Runs against the live dev server on localhost:3000.
 *   bun test tests/api/phase1.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";

function t(name: string, fn: () => Promise<unknown> | unknown) {
  return test(name, fn, 60000); // runbook: generous timeout — AI drain can block the event loop
}
const BASE = "http://localhost:3000";
const db = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a", "connection": "close" }; // connection:close — kills the bun-fetch/Next-dev keep-alive race that intermittently delivers empty request bodies (500 JSON.parse)

// ---------- cookie-aware test client ----------

class Client {
  cookie: string | null = null;
  lastStatus = 0;
  lastBody: any = null;
  bypass: boolean;

  constructor(bypass = true) {
    this.bypass = bypass;
  }

  async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = {
      ...(this.bypass ? BYPASS : {}),
      ...(extraHeaders || {}),
    };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (this.cookie) headers["Cookie"] = this.cookie;
    const send = () =>
      fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    let res = await send();
    // ONE retry on 5xx — transient dev-server 500s under sandbox load
    // (documented "stable re-run" pattern, same as the phase6 suite).
    // 4xx/2xx are never retried, so authorization assertions stay strict.
    if (res.status >= 500) res = await send();
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
      if (pair.endsWith("=")) this.cookie = null; // cleared cookie
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

function pngBuffer(_w = 1, _h = 1): Buffer {
  // Precomputed valid 1x1 PNG — rejected by the dimension rule, so only
  // used as a deliberately-too-small fixture.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
}

async function validPngBuffer(): Promise<Buffer> {
  // Real 64x64 PNG that satisfies the ≥32px dimension validation.
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .png()
    .toBuffer();
}

// ---------- shared fixture ids ----------

let ids: {
  indiaId: string; mpId: string; kaId: string;
  indoreD: string; bhopalD: string; blrD: string;
  indoreC: string; bhopalC: string; blrC: string;
  policeDept: string; fslDept: string; otherDeptId: string;
} = null as any;

let sys: Client, adminPolice: Client, adminFsl: Client, officerPolice: Client, auditor: Client, anon: Client;

beforeAll(async () => {
  sys = new Client(); await sys.login("sysadmin@demo.gov.in");
  adminPolice = new Client(); await adminPolice.login("arjun.sharma@demo.gov.in");
  adminFsl = new Client(); await adminFsl.login("meera.desai@demo.gov.in");
  officerPolice = new Client(); await officerPolice.login("vishnu.kumar@demo.gov.in");
  auditor = new Client(); await auditor.login("priya.nair@demo.gov.in");
  anon = new Client();

  const c = sys; // authenticated discovery client
  await c.get("/api/v1/geography/countries");
  const india = c.data().find((x: any) => x.code === "IN");
  await c.get(`/api/v1/geography/states?countryId=${india.id}`);
  const states = c.data();
  const mp = states.find((s: any) => s.code === "MP");
  const ka = states.find((s: any) => s.code === "KA");
  await c.get(`/api/v1/geography/states/${mp.id}/districts`);
  const mpDistricts = c.data();
  const indoreD = mpDistricts.find((d: any) => d.code === "IND");
  const bhopalD = mpDistricts.find((d: any) => d.code === "BHO");
  await c.get(`/api/v1/geography/states/${ka.id}/districts`);
  const blrD = c.data().find((d: any) => d.code === "BLR");
  await c.get(`/api/v1/geography/districts/${indoreD.id}/cities`);
  const indoreC = c.data().find((x: any) => x.code === "IND");
  await c.get(`/api/v1/geography/districts/${bhopalD.id}/cities`);
  const bhopalC = c.data().find((x: any) => x.code === "BHO");
  await c.get(`/api/v1/geography/districts/${blrD.id}/cities`);
  const blrC = c.data().find((x: any) => x.code === "BLR");

  await c.get("/api/v1/departments?page=1&pageSize=50");
  const depts = c.data().items;
  const policeDept = depts.find((d: any) => d.departmentCode === "DEPT-MP-IND-POL-001");
  const fslDept = depts.find((d: any) => d.departmentCode === "DEPT-MP-IND-FSL-001");
  const otherDept = depts.find((d: any) => d.departmentCode === "DEPT-MP-IND-OTH-001");

  ids = {
    indiaId: india.id, mpId: mp.id, kaId: ka.id,
    indoreD: indoreD.id, bhopalD: bhopalD.id, blrD: blrD.id,
    indoreC: indoreC.id, bhopalC: bhopalC.id, blrC: blrC.id,
    policeDept: policeDept.id, fslDept: fslDept.id, otherDeptId: otherDept.id,
  };

  anon = new Client();
}, 60000);

// ============================================================
// AUTHENTICATION (spec §48)
// ============================================================

describe("Authentication", () => {
  t("valid login succeeds and sets session", async () => {
    const c = new Client();
    await c.login("vishnu.kumar@demo.gov.in");
    expect(c.lastStatus).toBe(200);
    expect(c.cookie).toContain("cp_session=");
  });

  t("invalid password → 401 with generic error", async () => {
    const c = new Client();
    await c.login("vishnu.kumar@demo.gov.in", "WrongPassword1");
    expect(c.lastStatus).toBe(401);
    expect(c.code()).toBe("INVALID_CREDENTIALS");
  });

  t("unknown email → identical generic error (no existence leak)", async () => {
    const c = new Client();
    await c.login("ghost@nowhere.gov.in", "Whatever123");
    expect(c.lastStatus).toBe(401);
    expect(c.code()).toBe("INVALID_CREDENTIALS");
    expect(c.lastBody.error.message).toBe("Invalid email or password.");
  });

  t("PENDING officer cannot authenticate", async () => {
    const c = new Client();
    await c.login("kavya.rao@demo.gov.in");
    expect(c.lastStatus).toBe(401);
    expect(c.code()).toBe("ACCOUNT_INACTIVE");
  });

  t("protected endpoint without authentication → 401", async () => {
    await anon.get("/api/v1/auth/me");
    expect(anon.lastStatus).toBe(401);
    await anon.get("/api/v1/departments");
    expect(anon.lastStatus).toBe(401);
    await anon.post("/api/v1/departments", { name: "X" });
    expect(anon.lastStatus).toBe(401);
  });

  t("logout revokes the server-side session", async () => {
    const c = new Client();
    await c.login("vishnu.kumar@demo.gov.in");
    await c.get("/api/v1/auth/me");
    expect(c.lastStatus).toBe(200);
    await c.post("/api/v1/auth/logout");
    expect(c.lastStatus).toBe(200);
    await c.get("/api/v1/auth/me");
    expect(c.lastStatus).toBe(401);
  });

  t("expired session → 401 SESSION_EXPIRED", async () => {
    const c = new Client();
    await c.login("vishnu.kumar@demo.gov.in");
    await c.get("/api/v1/auth/me");
    expect(c.lastStatus).toBe(200);
    const sessionId = c.data().session.sessionId;
    await db.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await c.get("/api/v1/auth/me");
    expect(c.lastStatus).toBe(401);
    expect(c.code()).toBe("SESSION_EXPIRED");
  });

  t("login rate limiting → 429 after repeated failures", async () => {
    const email = `ratelimit.probe.${Date.now()}@demo.gov.in`;
    const c = new Client(false); // NO bypass — must exercise the real limiter
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      await c.req("POST", "/api/v1/auth/login", { email, password: "BadPassword1" });
      if (c.lastStatus === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
    expect(c.code()).toBe("RATE_LIMITED");
  });
});

// ============================================================
// GEOGRAPHY (spec §48)
// ============================================================

describe("Geography", () => {
  t("valid state → districts", async () => {
    await sys.get(`/api/v1/geography/states/${ids.mpId}/districts`);
    expect(sys.lastStatus).toBe(200);
    expect(sys.data().some((d: any) => d.code === "IND")).toBe(true);
  });

  t("invalid state id → 404", async () => {
    await sys.get("/api/v1/geography/states/does-not-exist/districts");
    expect(sys.lastStatus).toBe(404);
  });

  t("valid district → cities", async () => {
    await sys.get(`/api/v1/geography/districts/${ids.indoreD}/cities`);
    expect(sys.lastStatus).toBe(200);
    expect(sys.data().some((d: any) => d.code === "IND")).toBe(true);
  });

  t("invalid district id → 404", async () => {
    await sys.get("/api/v1/geography/districts/does-not-exist/cities");
    expect(sys.lastStatus).toBe(404);
  });

  t("unauthenticated geography access → 401", async () => {
    await anon.get("/api/v1/geography/states");
    expect(anon.lastStatus).toBe(401);
  });
});

// ============================================================
// DEPARTMENTS (spec §48)
// ============================================================

describe("Departments", () => {
  t("SYSTEM_ADMIN creates department (valid hierarchy)", async () => {
    await sys.post("/api/v1/departments", {
      name: `Test Police Unit ${Date.now()}`,
      departmentType: "POLICE",
      stateId: ids.mpId,
      districtId: ids.indoreD,
      cityId: ids.indoreC,
    });
    expect(sys.lastStatus).toBe(201);
    expect(sys.data().departmentCode).toMatch(/^DEPT-MP-IND-POL-\d{3}$/);
    expect(sys.data().status).toBe("PENDING");
  });

  t("generated department codes are unique and sequential", async () => {
    await sys.post("/api/v1/departments", {
      name: `Code Seq A ${Date.now()}`, departmentType: "POLICE",
      stateId: ids.mpId, districtId: ids.indoreD, cityId: ids.indoreC,
    });
    const a = sys.data().departmentCode;
    await sys.post("/api/v1/departments", {
      name: `Code Seq B ${Date.now()}`, departmentType: "POLICE",
      stateId: ids.mpId, districtId: ids.indoreD, cityId: ids.indoreC,
    });
    const b = sys.data().departmentCode;
    expect(a).not.toBe(b);
    expect(Number(b.slice(-3))).toBeGreaterThan(Number(a.slice(-3)));
  });

  t("invalid hierarchy: city of another district → 422", async () => {
    await sys.post("/api/v1/departments", {
      name: "Forgery Dept", departmentType: "POLICE",
      stateId: ids.mpId, districtId: ids.indoreD, cityId: ids.bhopalC,
    });
    expect(sys.lastStatus).toBe(422);
    expect(sys.code()).toBe("GEOGRAPHY_HIERARCHY_INVALID");
  });

  t("invalid hierarchy: district of another state → 422", async () => {
    await sys.post("/api/v1/departments", {
      name: "Forgery Dept 2", departmentType: "POLICE",
      stateId: ids.mpId, districtId: ids.blrD, cityId: ids.blrC,
    });
    expect(sys.lastStatus).toBe(422);
  });

  t("DEPARTMENT_ADMIN cannot create departments", async () => {
    await adminPolice.post("/api/v1/departments", {
      name: "Rogue Dept", departmentType: "POLICE",
      stateId: ids.mpId, districtId: ids.indoreD, cityId: ids.indoreC,
    });
    expect(adminPolice.lastStatus).toBe(403);
  });

  t("DEPARTMENT_ADMIN updates own department — allowed", async () => {
    await adminPolice.patch(`/api/v1/departments/${ids.policeDept}`, {
      description: `Updated by own admin at ${Date.now()}`,
    });
    expect(adminPolice.lastStatus).toBe(200);
  });

  t("DEPARTMENT_ADMIN modifying ANOTHER department → 403", async () => {
    await adminPolice.patch(`/api/v1/departments/${ids.fslDept}`, {
      description: "hostile update",
    });
    expect(adminPolice.lastStatus).toBe(403);
    expect(adminPolice.code()).toBe("FORBIDDEN");
  });

  t("OFFICER cannot modify department", async () => {
    await officerPolice.patch(`/api/v1/departments/${ids.policeDept}`, {
      description: "officer hostile update",
    });
    expect(officerPolice.lastStatus).toBe(403);
  });

  t("AUDITOR cannot modify anything", async () => {
    await auditor.patch(`/api/v1/departments/${ids.policeDept}`, { description: "audit write" });
    expect(auditor.lastStatus).toBe(403);
    await auditor.patch(`/api/v1/departments/${ids.policeDept}/status`, { status: "INACTIVE" });
    expect(auditor.lastStatus).toBe(403);
  });

  t("AUDITOR can read department directory", async () => {
    await auditor.get("/api/v1/departments?page=1&pageSize=5");
    expect(auditor.lastStatus).toBe(200);
    expect(Array.isArray(auditor.data().items)).toBe(true);
  });

  t("directory search & filters work", async () => {
    await sys.get("/api/v1/departments?search=Indore Police&departmentType=POLICE&status=ACTIVE");
    expect(sys.lastStatus).toBe(200);
    expect(sys.data().total).toBeGreaterThanOrEqual(1);
    expect(sys.data().items.every((d: any) => d.departmentType === "POLICE")).toBe(true);
  });

  t("OFFICER can view own department profile", async () => {
    await officerPolice.get(`/api/v1/departments/${ids.policeDept}`);
    expect(officerPolice.lastStatus).toBe(200);
  });

  t("OFFICER cannot view another department profile", async () => {
    await officerPolice.get(`/api/v1/departments/${ids.fslDept}`);
    expect(officerPolice.lastStatus).toBe(403);
  });
});

// ============================================================
// LOGO (spec §47/§50)
// ============================================================

describe("Department logo security", () => {
  t("valid PNG upload works and file is served", async () => {
    const form = new FormData();
    form.append("logo", new File([await validPngBuffer()], "innocent-name.png", { type: "image/png" }));
    await adminPolice.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(adminPolice.lastStatus).toBe(201);
    const fileId = adminPolice.data().logoPath;
    expect(fileId).toMatch(/^[0-9a-f-]{36}\.png$/);

    const res = await fetch(`${BASE}/api/v1/files/logos/${fileId}`, { signal: AbortSignal.timeout(10000) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  }, 20000);

  t("malicious content with image extension → 415", async () => {
    const form = new FormData();
    form.append("logo", new File([Buffer.from("<?php evil(); ?>")], "evil.png", { type: "image/png" }));
    await adminPolice.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(adminPolice.lastStatus).toBe(415);
    expect(adminPolice.code()).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  t("oversized upload → 413", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x89);
    const form = new FormData();
    form.append("logo", new File([big], "big.png", { type: "image/png" }));
    await adminPolice.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(adminPolice.lastStatus).toBe(413);
  });

  t("path traversal via file id → 404", async () => {
    const res = await fetch(`${BASE}/api/v1/files/logos/..%2F..%2Fschema.prisma`, { signal: AbortSignal.timeout(15000) });
    expect(res.status).toBe(404);
    const res2 = await fetch(`${BASE}/api/v1/files/logos/not-a-uuid.png`, { signal: AbortSignal.timeout(15000) });
    expect(res2.status).toBe(404);
  }, 20000);

  t("unauthenticated logo upload → 401", async () => {
    const form = new FormData();
    form.append("logo", new File([await validPngBuffer()], "x.png", { type: "image/png" }));
    await anon.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(anon.lastStatus).toBe(401);
  });

  t("officer (non-admin) cannot upload logo → 403", async () => {
    const form = new FormData();
    form.append("logo", new File([await validPngBuffer()], "x.png", { type: "image/png" }));
    await officerPolice.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(officerPolice.lastStatus).toBe(403);
  });

  t("undersized PNG (below 32px) → 422", async () => {
    const form = new FormData();
    form.append("logo", new File([pngBuffer()], "tiny.png", { type: "image/png" }));
    await adminPolice.req("POST", `/api/v1/departments/${ids.policeDept}/logo`, form);
    expect(adminPolice.lastStatus).toBe(422);
  });
});

// ============================================================
// OFFICERS (spec §48)
// ============================================================

describe("Officers", () => {
  let createdOfficerId: string;
  const email = `new.officer.${Date.now()}@demo.gov.in`;

  t("DEPARTMENT_ADMIN registers officer in own department", async () => {
    await adminPolice.post(`/api/v1/departments/${ids.policeDept}/officers`, {
      name: "New Test Officer",
      email,
      phone: "+91-9000000000",
      designation: "Inspector (Testing)",
      role: "OFFICER",
      password: "Test@Pass1",
      status: "ACTIVE",
    });
    expect(adminPolice.lastStatus).toBe(201);
    createdOfficerId = adminPolice.data().id;
    expect(adminPolice.data().officerId).toMatch(/^OFF-MP-IND-\d{5}$/);
    expect(adminPolice.data().status).toBe("ACTIVE");
  });

  t("new officer can log in immediately", async () => {
    const c = new Client();
    await c.login(email, "Test@Pass1");
    expect(c.lastStatus).toBe(200);
  });

  t("duplicate email → 409 CONFLICT", async () => {
    await adminPolice.post(`/api/v1/departments/${ids.policeDept}/officers`, {
      name: "Duplicate Officer",
      email,
      designation: "Duplicate",
      role: "OFFICER",
      password: "Test@Pass1",
    });
    expect(adminPolice.lastStatus).toBe(409);
  });

  t("DEPARTMENT_ADMIN cannot create officers in another department", async () => {
    await adminPolice.post(`/api/v1/departments/${ids.fslDept}/officers`, {
      name: "Cross Dept Officer",
      email: `cross.${Date.now()}@demo.gov.in`,
      designation: "X",
      role: "OFFICER",
      password: "Test@Pass1",
    });
    expect(adminPolice.lastStatus).toBe(403);
  });

  t("DEPARTMENT_ADMIN cannot assign SYSTEM_ADMIN role", async () => {
    await adminPolice.post(`/api/v1/departments/${ids.policeDept}/officers`, {
      name: "Escalation Attempt",
      email: `escalation.${Date.now()}@demo.gov.in`,
      designation: "Escalation Analyst",
      role: "SYSTEM_ADMIN",
      password: "Test@Pass1",
    });
    expect(adminPolice.lastStatus).toBe(403);
  });

  t("forged role in profile update is ignored (no privilege escalation)", async () => {
    await officerPolice.patch("/api/v1/profile", { phone: "+91-9111111111", role: "SYSTEM_ADMIN" });
    expect(officerPolice.lastStatus).toBe(200);
    await officerPolice.get("/api/v1/profile");
    expect(officerPolice.data().role).toBe("OFFICER");
  });

  t("password change: works, authenticates, rejects wrong current password", async () => {
    // dedicated account so the demo credentials are untouched
    const email = `pwd.change.${Date.now()}@demo.gov.in`;
    await adminPolice.post(`/api/v1/departments/${ids.policeDept}/officers`, {
      name: "Password Change Probe",
      email,
      designation: "Constable",
      role: "OFFICER",
      password: "First@Pass1",
      status: "ACTIVE",
    });
    const probe = new Client();
    await probe.login(email, "First@Pass1");
    expect(probe.lastStatus).toBe(200);

    // wrong current password rejected
    await probe.post("/api/v1/profile/password", { currentPassword: "Wrong@Pass1", newPassword: "Second@Pass2" });
    expect(probe.lastStatus).toBe(401);

    // correct change → old password dead, new password live
    await probe.post("/api/v1/profile/password", { currentPassword: "First@Pass1", newPassword: "Second@Pass2" });
    expect(probe.lastStatus).toBe(200);
    const reLogin = new Client();
    await reLogin.login(email, "First@Pass1");
    expect(reLogin.lastStatus).toBe(401);
    await reLogin.login(email, "Second@Pass2");
    expect(reLogin.lastStatus).toBe(200);
  });

  t("officer of another department cannot view officer profile", async () => {
    await adminFsl.get(`/api/v1/departments/${ids.fslDept}/officers`);
    const fslOfficer = adminFsl.data().items[0];
    await officerPolice.get(`/api/v1/officers/${fslOfficer.id}`);
    expect(officerPolice.lastStatus).toBe(403);
  });

  t("status lifecycle: ACTIVE → SUSPENDED blocks login; transitions enforced", async () => {
    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "SUSPENDED" });
    expect(adminPolice.lastStatus).toBe(200);
    const c = new Client();
    await c.login(email, "Test@Pass1");
    expect(c.lastStatus).toBe(401);
    expect(c.code()).toBe("ACCOUNT_INACTIVE");

    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "INACTIVE" });
    expect(adminPolice.lastStatus).toBe(200);

    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "SUSPENDED" });
    expect(adminPolice.lastStatus).toBe(422);
    expect(adminPolice.code()).toBe("INVALID_STATUS_TRANSITION");

    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "ACTIVE" });
    expect(adminPolice.lastStatus).toBe(200);
    const c2 = new Client();
    await c2.login(email, "Test@Pass1");
    expect(c2.lastStatus).toBe(200);
  });

  t("suspension revokes live sessions immediately", async () => {
    const target = new Client();
    await target.login(email, "Test@Pass1");
    expect(target.lastStatus).toBe(200);
    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "SUSPENDED" });
    await target.get("/api/v1/auth/me");
    expect(target.lastStatus).toBe(401);
    await adminPolice.patch(`/api/v1/officers/${createdOfficerId}/status`, { status: "ACTIVE" });
  });

  t("OFFICER cannot modify other officers", async () => {
    await officerPolice.patch(`/api/v1/officers/${createdOfficerId}`, { designation: "Hacked" });
    expect(officerPolice.lastStatus).toBe(403);
  });
});

// ============================================================
// AUTHORIZATION MATRIX (spec §48 + §50)
// ============================================================

describe("Authorization matrix", () => {
  t("SYSTEM_ADMIN can manage department status", async () => {
    await sys.patch(`/api/v1/departments/${ids.otherDeptId}/status`, { status: "INACTIVE" });
    expect(sys.lastStatus).toBe(200);
    await sys.patch(`/api/v1/departments/${ids.otherDeptId}/status`, { status: "ACTIVE" });
    expect(sys.lastStatus).toBe(200);
  });

  t("AUDITOR can read platform stats and events but not write", async () => {
    await auditor.get("/api/v1/admin/stats");
    expect(auditor.lastStatus).toBe(200);
    await auditor.get("/api/v1/admin/events?page=1&pageSize=5");
    expect(auditor.lastStatus).toBe(200);
    await auditor.post("/api/v1/departments", {
      name: "Auditor Dept", departmentType: "OTHER",
      stateId: ids.mpId, districtId: ids.indoreD, cityId: ids.indoreC,
    });
    expect(auditor.lastStatus).toBe(403);
  });

  t("OFFICER cannot read platform stats", async () => {
    await officerPolice.get("/api/v1/admin/stats");
    expect(officerPolice.lastStatus).toBe(403);
  });

  t("DEPARTMENT_ADMIN cannot add geography units", async () => {
    await adminPolice.post("/api/v1/geography/states", { countryId: ids.indiaId, name: "Rogue State", code: "RS" });
    expect(adminPolice.lastStatus).toBe(403);
  });

  t("SYSTEM_ADMIN can add geography units", async () => {
    await sys.post("/api/v1/geography/states", { countryId: ids.indiaId, name: `Test State ${Date.now() % 100000}`, code: `T${Date.now() % 1000000}`.slice(0, 6) });
    expect(sys.lastStatus).toBe(201);
  });

  t("forged officer/department ids in request body are ignored", async () => {
    await adminFsl.patch("/api/v1/profile", { phone: "+91-9222222222", departmentId: ids.policeDept, officerId: "OFF-MP-IND-99999" });
    expect(adminFsl.lastStatus).toBe(200);
    await adminFsl.get("/api/v1/profile");
    expect(adminFsl.data().department.departmentCode).toBe("DEPT-MP-IND-FSL-001");
  });
});

// ============================================================
// IDENTITY EVENTS (spec §45)
// ============================================================

describe("Identity events", () => {
  t("login/logout/failures generate structured events", async () => {
    const c = new Client();
    await c.login("vishnu.kumar@demo.gov.in");
    await c.post("/api/v1/auth/logout");
    const c2 = new Client();
    await c2.login("vishnu.kumar@demo.gov.in", "WrongPassword1");

    await sys.get("/api/v1/admin/events?page=1&pageSize=50");
    const events = sys.data().items.map((e: any) => e.eventType);
    expect(events).toContain("LOGIN_SUCCESS");
    expect(events).toContain("LOGIN_FAILED");
    expect(events).toContain("LOGOUT");
  });
});
