import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const officers = await db.officer.findMany({
    select: { email: true, name: true, authenticationStatus: true },
    orderBy: { email: "asc" },
  });
  const departments = await db.department.findMany({
    select: { departmentCode: true, name: true, status: true },
    orderBy: { departmentCode: "asc" },
  });
  const cases = await db.case.findMany({
    select: { caseId: true, title: true, status: true, currentCustodianDepartmentId: true },
    orderBy: { caseId: "asc" },
  });
  const transfers = await db.caseTransfer.findMany({
    select: { transferId: true, status: true },
    orderBy: { transferId: "asc" },
  });
  const caseEvents = await db.caseEvent.count();
  const sessions = await db.session.count({ where: { revokedAt: null } });

  console.log("=== OFFICERS (" + officers.length + ") ===");
  for (const o of officers) console.log(`  ${o.email} | ${o.name} | ${o.authenticationStatus}`);
  console.log("=== DEPARTMENTS (" + departments.length + ") ===");
  for (const d of departments) console.log(`  ${d.departmentCode} | ${d.name} | ${d.status}`);
  console.log("=== CASES (" + cases.length + ") ===");
  for (const c of cases) console.log(`  ${c.caseId} | ${c.status} | custodianDept=${c.currentCustodianDepartmentId} | ${c.title}`);
  console.log("=== TRANSFERS (" + transfers.length + ") ===");
  for (const t of transfers) console.log(`  ${t.transferId} | ${t.status}`);
  console.log(`CaseEvents: ${caseEvents}`);
  console.log(`Active sessions: ${sessions}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
