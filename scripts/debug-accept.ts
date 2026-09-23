/**
 * Debug: full transfer accept flow against live server.
 */
const BASE = "http://localhost:3000";
const BYPASS = { "x-test-bypass-rate-limit": "phase1-local-test-bypass-9f3a" };

class C {
  cookie: string | null = null;
  body: any;
  status = 0;
  async req(m: string, p: string, b?: unknown) {
    const h: Record<string, string> = { ...BYPASS };
    if (b !== undefined) h["Content-Type"] = "application/json";
    if (this.cookie) h["Cookie"] = this.cookie;
    const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b !== undefined ? JSON.stringify(b) : undefined });
    this.status = r.status;
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const t = await r.text();
    try { this.body = JSON.parse(t); } catch { this.body = { raw: t }; }
    return r;
  }
  d() { return this.body?.data; }
}

const police = new C(); await police.req("POST", "/api/v1/auth/login", { email: "arjun.sharma@demo.gov.in", password: "Demo@Pass1" });
const fsl = new C(); await fsl.req("POST", "/api/v1/auth/login", { email: "meera.desai@demo.gov.in", password: "Demo@Pass1" });

// geography
await police.req("GET", "/api/v1/geography/countries");
const india = police.d().find((x: any) => x.code === "IN");
await police.req("GET", `/api/v1/geography/states?countryId=${india.id}`);
const mp = police.d().find((s: any) => s.code === "MP");
await police.req("GET", `/api/v1/geography/states/${mp.id}/districts`);
const ind = police.d().find((d: any) => d.code === "IND");
await police.req("GET", `/api/v1/geography/districts/${ind.id}/cities`);
const city = police.d()[0];

// create case
await police.req("POST", "/api/v1/cases", {
  title: "Debug Accept Flow Case", caseType: "CRIMINAL", priority: "NORMAL",
  stateId: mp.id, districtId: ind.id, cityId: city.id,
});
console.log("create:", police.status);
const caseId = police.d().caseId;

// departments
await police.req("GET", "/api/v1/departments?page=1&pageSize=100");
const depts = police.d().items;
const fslDept = depts.find((d: any) => d.departmentCode === "DEPT-MP-IND-FSL-001");

// transfer request
await police.req("POST", `/api/v1/cases/${caseId}/transfers`, {
  toDepartmentId: fslDept.id, reason: "Debug transfer",
});
console.log("transfer request:", police.status, JSON.stringify(police.body).slice(0, 200));

// fsl views
await fsl.req("GET", `/api/v1/cases/${caseId}`);
console.log("fsl view:", fsl.status, fsl.body?.data?.viewer);

// fsl history
await fsl.req("GET", `/api/v1/cases/${caseId}/transfers`);
console.log("fsl history:", fsl.status, "items:", fsl.d()?.items?.length);
const trf = fsl.d()?.items?.[0]?.transferId;
console.log("transferId:", trf);

// accept
await fsl.req("POST", `/api/v1/cases/${caseId}/transfers/${trf}/accept`);
console.log("accept:", fsl.status, JSON.stringify(fsl.body).slice(0, 300));
