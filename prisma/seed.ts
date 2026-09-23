/**
 * Phase 1 seed data (spec §34) — idempotent, development/demo only.
 *
 * DEMO ACCOUNTS — never ship these passwords to production.
 * Password source: SEED_PASSWORD env var (default Demo@Pass1).
 * Run: bun prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_PASSWORD || "Demo@Pass1";

async function main() {
  const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 11);

  // ---- Geography: India root -------------------------------------------------
  const india = await db.country.upsert({
    where: { code: "IN" },
    update: {},
    create: { name: "India", code: "IN" },
  });

  const mp = await db.state.upsert({
    where: { countryId_code: { countryId: india.id, code: "MP" } },
    update: {},
    create: { countryId: india.id, name: "Madhya Pradesh", code: "MP" },
  });
  const ka = await db.state.upsert({
    where: { countryId_code: { countryId: india.id, code: "KA" } },
    update: {},
    create: { countryId: india.id, name: "Karnataka", code: "KA" },
  });

  const indoreD = await db.district.upsert({
    where: { stateId_code: { stateId: mp.id, code: "IND" } },
    update: {},
    create: { stateId: mp.id, name: "Indore", code: "IND" },
  });
  const bhopalD = await db.district.upsert({
    where: { stateId_code: { stateId: mp.id, code: "BHO" } },
    update: {},
    create: { stateId: mp.id, name: "Bhopal", code: "BHO" },
  });
  const ujjainD = await db.district.upsert({
    where: { stateId_code: { stateId: mp.id, code: "UJJ" } },
    update: {},
    create: { stateId: mp.id, name: "Ujjain", code: "UJJ" },
  });
  const blrUrbanD = await db.district.upsert({
    where: { stateId_code: { stateId: ka.id, code: "BLR" } },
    update: {},
    create: { stateId: ka.id, name: "Bengaluru Urban", code: "BLR" },
  });

  const indoreC = await db.city.upsert({
    where: { districtId_code: { districtId: indoreD.id, code: "IND" } },
    update: {},
    create: { districtId: indoreD.id, name: "Indore", code: "IND" },
  });
  const bhopalC = await db.city.upsert({
    where: { districtId_code: { districtId: bhopalD.id, code: "BHO" } },
    update: {},
    create: { districtId: bhopalD.id, name: "Bhopal", code: "BHO" },
  });
  const ujjainC = await db.city.upsert({
    where: { districtId_code: { districtId: ujjainD.id, code: "UJJ" } },
    update: {},
    create: { districtId: ujjainD.id, name: "Ujjain", code: "UJJ" },
  });
  const blrC = await db.city.upsert({
    where: { districtId_code: { districtId: blrUrbanD.id, code: "BLR" } },
    update: {},
    create: { districtId: blrUrbanD.id, name: "Bengaluru", code: "BLR" },
  });

  // ---- Departments ------------------------------------------------------------
  async function upsertDepartment(departmentCode: string, name: string, departmentType: string, cityId: string, stateId: string, districtId: string) {
    return db.department.upsert({
      where: { departmentCode },
      update: {},
      create: { departmentCode, name, departmentType, cityId, stateId, districtId, status: "ACTIVE" },
    });
  }

  const police = await upsertDepartment("DEPT-MP-IND-POL-001", "Indore Police Department", "POLICE", indoreC.id, mp.id, indoreD.id);
  const forensics = await upsertDepartment("DEPT-MP-IND-FSL-001", "Indore Forensic Science Laboratory", "FORENSICS", indoreC.id, mp.id, indoreD.id);
  const prosecution = await upsertDepartment("DEPT-MP-IND-PRO-001", "Indore Prosecution Department", "PROSECUTION", indoreC.id, mp.id, indoreD.id);
  const bhopalPolice = await upsertDepartment("DEPT-MP-BHO-POL-001", "Bhopal Police Department", "POLICE", bhopalC.id, mp.id, bhopalD.id);
  const platform = await upsertDepartment("DEPT-MP-IND-OTH-001", "Central Platform Administration", "OTHER", indoreC.id, mp.id, indoreD.id);

  // ---- Officers (DEMO accounts) ------------------------------------------------
  async function upsertOfficer(officerId: string, departmentId: string, name: string, email: string, phone: string | null, designation: string, role: string, status: string) {
    return db.officer.upsert({
      where: { officerId },
      update: {},
      create: { officerId, departmentId, name, email, phone, designation, role, status, passwordHash },
    });
  }

  await upsertOfficer("OFF-MP-IND-00001", police.id, "Arjun Sharma", "arjun.sharma@demo.gov.in", "+91-9876500001", "Superintendent of Police", "DEPARTMENT_ADMIN", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00002", forensics.id, "Meera Desai", "meera.desai@demo.gov.in", "+91-9876500002", "Director, FSL", "DEPARTMENT_ADMIN", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00003", prosecution.id, "Rohan Verma", "rohan.verma@demo.gov.in", "+91-9876500003", "Chief Prosecutor", "DEPARTMENT_ADMIN", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00004", police.id, "Vishnu Kumar", "vishnu.kumar@demo.gov.in", "+91-9876500004", "Sub-Inspector", "OFFICER", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00005", police.id, "Kavya Rao", "kavya.rao@demo.gov.in", "+91-9876500005", "Constable", "OFFICER", "PENDING");
  await upsertOfficer("OFF-MP-BHO-00006", bhopalPolice.id, "Devika Iyer", "devika.iyer@demo.gov.in", "+91-9876500006", "Inspector", "OFFICER", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00007", platform.id, "Platform Administrator", "sysadmin@demo.gov.in", "+91-9876500007", "Platform Administrator", "SYSTEM_ADMIN", "ACTIVE");
  await upsertOfficer("OFF-MP-IND-00008", platform.id, "Priya Nair", "priya.nair@demo.gov.in", "+91-9876500008", "Compliance Auditor", "AUDITOR", "ACTIVE");

  console.log("============================================================");
  console.log("Phase 1 seed complete  [DEMO / DEVELOPMENT DATA]");
  console.log(`  Country : ${india.name} (${india.code})`);
  console.log(`  States  : ${mp.name}, ${ka.name}`);
  console.log("  Departments: 5 (Police, Forensics, Prosecution, Bhopal Police, Platform Admin)");
  console.log("  Officers   : 8");
  console.log("");
  console.log("  DEMO LOGIN ACCOUNTS (label: seed/demo — DO NOT SHIP):");
  console.log(`    SYSTEM_ADMIN      sysadmin@demo.gov.in            / ${SEED_PASSWORD}`);
  console.log(`    DEPARTMENT_ADMIN  arjun.sharma@demo.gov.in        / ${SEED_PASSWORD}  (Indore Police)`);
  console.log(`    DEPARTMENT_ADMIN  meera.desai@demo.gov.in         / ${SEED_PASSWORD}  (Indore FSL)`);
  console.log(`    OFFICER           vishnu.kumar@demo.gov.in        / ${SEED_PASSWORD}  (Indore Police)`);
  console.log(`    AUDITOR           priya.nair@demo.gov.in          / ${SEED_PASSWORD}`);
  console.log("============================================================");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
