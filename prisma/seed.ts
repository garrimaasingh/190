/**
 * Phase 1 seed data (spec §34) — idempotent, development/demo only.
 *
 * DEMO ACCOUNTS — never ship these passwords to production.
 * Password source: SEED_PASSWORD env var (default Demo@Pass1).
 * Run: bun prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
// Phase 8: credentials go through the SAME secret abstraction as the
// API layer (encrypted store; the DB only ever holds a reference).
import { integrationCredentialService } from "../src/lib/integrations/credentials";

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

  // ===========================================================================
  // PHASE 2 — demonstration cases (spec §53). All data is synthetic demo
  // data. Re-runs are idempotent: child records are only written when the
  // case is first created.
  // ===========================================================================
  const now = Date.now();
  const daysAgo = (d: number, h = 0) => new Date(now - d * 86400000 - h * 3600000);

  async function ensureDemoCase(def: {
    caseId: string;
    caseNumber?: string;
    title: string;
    description: string;
    caseType: string;
    priority: string;
    status: string;
    custodian: { id: string; name: string };
    custodianOfficerId?: string | null;
    createdByOfficerId: string;
    createdByDepartmentId: string;
    createdDaysAgo: number;
    openedDaysAgo: number;
    closedDaysAgo?: number;
  }) {
    const existing = await db.case.findUnique({ where: { caseId: def.caseId } });
    if (existing) return { case: existing, created: false };

    const c = await db.case.create({
      data: {
        caseId: def.caseId,
        caseNumber: def.caseNumber ?? null,
        title: def.title,
        description: def.description,
        caseType: def.caseType,
        priority: def.priority,
        status: def.status,
        stateId: mp.id,
        districtId: indoreD.id,
        cityId: indoreC.id,
        originatingDepartmentId: def.createdByDepartmentId,
        currentCustodianDepartmentId: def.custodian.id,
        currentCustodianOfficerId: def.custodianOfficerId ?? null,
        createdByOfficerId: def.createdByOfficerId,
        createdByDepartmentId: def.createdByDepartmentId,
        openedAt: daysAgo(def.openedDaysAgo),
        closedAt: def.closedDaysAgo ? daysAgo(def.closedDaysAgo) : null,
        createdAt: daysAgo(def.createdDaysAgo),
      },
    });
    // createdAt is immutable after create — pin the demo date.
    await db.case.update({ where: { id: c.id }, data: { createdAt: daysAgo(def.createdDaysAgo) } });
    return { case: c, created: true };
  }

  async function addParticipation(caseInternalId: string, departmentId: string, participationType: string, addedDaysAgo: number) {
    const existing = await db.caseDepartment.findUnique({
      where: { caseId_departmentId: { caseId: caseInternalId, departmentId } },
    });
    if (existing) return existing;
    return db.caseDepartment.create({
      data: {
        caseId: caseInternalId,
        departmentId,
        participationType,
        joinedAt: daysAgo(addedDaysAgo),
      },
    });
  }

  async function addAssignment(caseInternalId: string, officerId: string, departmentId: string, roleOnCase: string, assignedDaysAgo: number) {
    const existing = await db.caseOfficer.findUnique({
      where: { caseId_officerId: { caseId: caseInternalId, officerId } },
    });
    if (existing) return existing;
    return db.caseOfficer.create({
      data: {
        caseId: caseInternalId,
        officerId,
        departmentId,
        roleOnCase,
        assignedAt: daysAgo(assignedDaysAgo),
      },
    });
  }

  async function addEvent(caseInternalId: string, eventType: string, actorOfficerId: string | null, departmentId: string | null, description: string, daysAgoVal: number, hoursOffset = 0) {
    return db.caseEvent.create({
      data: {
        caseId: caseInternalId,
        eventType,
        actorOfficerId,
        departmentId,
        targetType: "CASE",
        targetId: caseInternalId,
        description,
        createdAt: daysAgo(daysAgoVal, hoursOffset),
      },
    });
  }

  async function ensureTransfer(def: {
    transferId: string;
    caseInternalId: string;
    fromDepartmentId: string;
    toDepartmentId: string;
    toOfficerId?: string | null;
    requestedByOfficerId: string;
    acceptedByOfficerId?: string | null;
    status: string;
    reason: string;
    daysAgoVal: number;
  }) {
    const existing = await db.caseTransfer.findUnique({ where: { transferId: def.transferId } });
    if (existing) return existing;
    return db.caseTransfer.create({
      data: {
        transferId: def.transferId,
        caseId: def.caseInternalId,
        fromDepartmentId: def.fromDepartmentId,
        toDepartmentId: def.toDepartmentId,
        toOfficerId: def.toOfficerId ?? null,
        requestedByOfficerId: def.requestedByOfficerId,
        acceptedByOfficerId: def.acceptedByOfficerId ?? null,
        status: def.status,
        reason: def.reason,
        requestedAt: daysAgo(def.daysAgoVal, 2),
        acceptedAt: def.status === "ACCEPTED" ? daysAgo(def.daysAgoVal) : null,
      },
    });
  }

  const sysadminOfficer = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00007" } });
  const arjun = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00001" } });
  const meera = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00002" } });
  const rohan = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00003" } });
  const vishnu = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00004" } });

  // ---- Case 1: Police custodian, under investigation (spec §53 #1) ----------
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000001",
      caseNumber: "FIR/124/2026",
      title: "Demonstration Cybercrime Investigation",
      description:
        "DEMO CASE (synthetic data). Online financial fraud ring targeting citizens of Indore. Registered at Indore Police; under active investigation with forensic support.",
      caseType: "CYBERCRIME",
      priority: "HIGH",
      status: "UNDER_INVESTIGATION",
      custodian: { id: police.id, name: police.name },
      custodianOfficerId: vishnu.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 30,
      openedDaysAgo: 30,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 30);
      await addParticipation(c.id, forensics.id, "PARTICIPATING", 22);
      await addAssignment(c.id, vishnu.id, police.id, "LEAD_INVESTIGATOR", 29);
      await addAssignment(c.id, arjun.id, police.id, "REVIEWER", 29);
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 30);
      await addEvent(c.id, "CASE_OFFICER_ASSIGNED", arjun.id, police.id, "Vishnu Kumar (Indore Police Department) assigned as lead investigator", 29);
      await addEvent(c.id, "CASE_DEPARTMENT_ADDED", arjun.id, police.id, "Indore Forensic Science Laboratory added as participating participant", 22);
      await addEvent(c.id, "CASE_STATUS_CHANGED", arjun.id, police.id, "Status changed from OPEN to UNDER_INVESTIGATION", 20);
    }
  }

  // ---- Case 2: Forensics custodian after accepted transfer (spec §53 #2) ----
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000002",
      caseNumber: "FIR/097/2026",
      title: "Digital Evidence Examination — Demo",
      description:
        "DEMO CASE (synthetic data). Seized devices submitted for forensic examination. Originated with Indore Police; custody transferred to the Forensic Science Laboratory.",
      caseType: "FORENSIC",
      priority: "CRITICAL",
      status: "PENDING_FORENSICS",
      custodian: { id: forensics.id, name: forensics.name },
      custodianOfficerId: meera.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 18,
      openedDaysAgo: 18,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 18);
      await addParticipation(c.id, forensics.id, "ACTIVE_CUSTODIAN", 12);
      await addAssignment(c.id, vishnu.id, police.id, "INVESTIGATING_OFFICER", 17);
      await addAssignment(c.id, meera.id, forensics.id, "FORENSIC_OFFICER", 12);
      const trf = await ensureTransfer({
        transferId: "TRF-MP-IND-2026-000001",
        caseInternalId: c.id,
        fromDepartmentId: police.id,
        toDepartmentId: forensics.id,
        toOfficerId: meera.id,
        requestedByOfficerId: arjun.id,
        acceptedByOfficerId: meera.id,
        status: "ACCEPTED",
        reason: "Devices require laboratory examination by FSL specialists.",
        daysAgoVal: 12,
      });
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 18);
      await addEvent(c.id, "CASE_OFFICER_ASSIGNED", arjun.id, police.id, "Vishnu Kumar (Indore Police Department) assigned as investigating officer", 17);
      await addEvent(c.id, "CASE_TRANSFER_REQUESTED", arjun.id, police.id, "Custody transfer requested to Indore Forensic Science Laboratory", 12, 2);
      await addEvent(c.id, "CASE_TRANSFER_ACCEPTED", meera.id, forensics.id, "Custody accepted from Indore Police Department — Indore Forensic Science Laboratory is now the current custodian", 12);
      await addEvent(c.id, "CASE_STATUS_CHANGED", meera.id, forensics.id, "Status changed from UNDER_INVESTIGATION to PENDING_FORENSICS", 11);
      void trf;
    }
  }

  // ---- Case 3: Prosecution custodian (spec §53 #3) ---------------------------
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000003",
      caseNumber: "FIR/056/2026",
      title: "Commercial Fraud Prosecution — Demo",
      description:
        "DEMO CASE (synthetic data). Charge-sheeted commercial fraud matter with the Prosecution Department holding custody for trial preparation.",
      caseType: "FINANCIAL",
      priority: "NORMAL",
      status: "PENDING_PROSECUTION",
      custodian: { id: prosecution.id, name: prosecution.name },
      custodianOfficerId: rohan.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 60,
      openedDaysAgo: 60,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 60);
      await addParticipation(c.id, prosecution.id, "ACTIVE_CUSTODIAN", 40);
      await addAssignment(c.id, vishnu.id, police.id, "INVESTIGATING_OFFICER", 58);
      await addAssignment(c.id, rohan.id, prosecution.id, "PROSECUTION_OFFICER", 40);
      await ensureTransfer({
        transferId: "TRF-MP-IND-2026-000002",
        caseInternalId: c.id,
        fromDepartmentId: police.id,
        toDepartmentId: prosecution.id,
        toOfficerId: rohan.id,
        requestedByOfficerId: arjun.id,
        acceptedByOfficerId: rohan.id,
        status: "ACCEPTED",
        reason: "Investigation complete; charge sheet filed. Prosecution to hold custody.",
        daysAgoVal: 40,
      });
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 60);
      await addEvent(c.id, "CASE_TRANSFER_REQUESTED", arjun.id, police.id, "Custody transfer requested to Indore Prosecution Department", 40, 3);
      await addEvent(c.id, "CASE_TRANSFER_ACCEPTED", rohan.id, prosecution.id, "Custody accepted from Indore Police Department — Indore Prosecution Department is now the current custodian", 40);
      await addEvent(c.id, "CASE_STATUS_CHANGED", rohan.id, prosecution.id, "Status changed from UNDER_INVESTIGATION to PENDING_PROSECUTION", 39);
    }
  }

  // ---- Case 4: Closed case (spec §53 #4) --------------------------------------
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000004",
      caseNumber: "FIR/212/2025",
      title: "Resolved Property Dispute — Demo",
      description:
        "DEMO CASE (synthetic data). Fully investigated and closed matter retained for the record. Demonstrates terminal lifecycle handling.",
      caseType: "CRIMINAL",
      priority: "LOW",
      status: "CLOSED",
      custodian: { id: police.id, name: police.name },
      custodianOfficerId: vishnu.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 220,
      openedDaysAgo: 220,
      closedDaysAgo: 30,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 220);
      await addAssignment(c.id, vishnu.id, police.id, "INVESTIGATING_OFFICER", 219);
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 220);
      await addEvent(c.id, "CASE_STATUS_CHANGED", arjun.id, police.id, "Status changed from OPEN to UNDER_INVESTIGATION", 210);
      await addEvent(c.id, "CASE_STATUS_CHANGED", arjun.id, police.id, "Status changed from UNDER_INVESTIGATION to CLOSED", 30);
    }
  }

  // ---- Case 5: Multi-participant case (spec §53 #5) ---------------------------
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000005",
      title: "Coordinated Multi-Agency Inquiry — Demo",
      description:
        "DEMO CASE (synthetic data). Police-led inquiry with forensic and prosecution departments participating concurrently, illustrating multi-department association.",
      caseType: "ORGANIZED_CRIME",
      priority: "HIGH",
      status: "OPEN",
      custodian: { id: police.id, name: police.name },
      custodianOfficerId: arjun.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 8,
      openedDaysAgo: 8,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 8);
      await addParticipation(c.id, forensics.id, "PARTICIPATING", 6);
      await addParticipation(c.id, prosecution.id, "CONSULTED", 5);
      await addAssignment(c.id, vishnu.id, police.id, "LEAD_INVESTIGATOR", 7);
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 8);
      await addEvent(c.id, "CASE_DEPARTMENT_ADDED", arjun.id, police.id, "Indore Forensic Science Laboratory added as participating participant", 6);
      await addEvent(c.id, "CASE_DEPARTMENT_ADDED", arjun.id, police.id, "Indore Prosecution Department added as consulted participant", 5);
      await addEvent(c.id, "CASE_OFFICER_ASSIGNED", arjun.id, police.id, "Vishnu Kumar (Indore Police Department) assigned as lead investigator", 7);
    }
  }

  // ---- Case 6: Pending incoming transfer (drives the accept flow demo) --------
  {
    const { case: c, created } = await ensureDemoCase({
      caseId: "CASE-MP-IND-2026-000006",
      title: "Narcotics Seizure Analysis Request — Demo",
      description:
        "DEMO CASE (synthetic data). Indore Police has requested a custody transfer to the Forensic Science Laboratory for substance analysis. The transfer is awaiting acceptance.",
      caseType: "CRIMINAL",
      priority: "NORMAL",
      status: "UNDER_INVESTIGATION",
      custodian: { id: police.id, name: police.name },
      custodianOfficerId: vishnu.id,
      createdByOfficerId: arjun.id,
      createdByDepartmentId: police.id,
      createdDaysAgo: 5,
      openedDaysAgo: 5,
    });
    if (created) {
      await addParticipation(c.id, police.id, "ORIGINATING", 5);
      await addAssignment(c.id, vishnu.id, police.id, "INVESTIGATING_OFFICER", 4);
      await ensureTransfer({
        transferId: "TRF-MP-IND-2026-000003",
        caseInternalId: c.id,
        fromDepartmentId: police.id,
        toDepartmentId: forensics.id,
        toOfficerId: meera.id,
        requestedByOfficerId: arjun.id,
        status: "REQUESTED",
        reason: "Seized substances require laboratory analysis by FSL.",
        daysAgoVal: 1,
      });
      await addEvent(c.id, "CASE_CREATED", arjun.id, police.id, "Case created by Arjun Sharma (Indore Police Department)", 5);
      await addEvent(c.id, "CASE_OFFICER_ASSIGNED", arjun.id, police.id, "Vishnu Kumar (Indore Police Department) assigned as investigating officer", 4);
      await addEvent(c.id, "CASE_STATUS_CHANGED", arjun.id, police.id, "Status changed from OPEN to UNDER_INVESTIGATION", 3);
      await addEvent(c.id, "CASE_TRANSFER_REQUESTED", arjun.id, police.id, "Custody transfer requested to Indore Forensic Science Laboratory", 1, 4);
    }
  }

  void sysadminOfficer;

  // ============================================================
  // PHASE 3 — demo documents on CASE-MP-IND-2026-000001 (spec §91).
  // Synthetic generated PDFs ONLY (no real confidential material).
  // Seeded through the SAME pipeline as the API: SHA-256 over the
  // plaintext → AES-256-GCM encrypt → opaque storage key → commit.
  // ============================================================
  {
    const case1 = await db.case.findUnique({ where: { caseId: "CASE-MP-IND-2026-000001" } });
    if (case1) {
      const existingDocs = await db.caseDocument.count({ where: { caseId: case1.id } });
      if (existingDocs === 0) {
        const { encryptDocument } = await import("@/lib/documents/encryption");
        const { calculateSha256 } = await import("@/lib/documents/integrity");
        const { DocumentStorage, buildStorageKey } = await import("@/lib/documents/storage");
        const { randomUUID } = await import("crypto");

        // Minimal but fully valid PDF 1.4 generator (synthetic demo content).
        // Text is deliberately RICH (dates, names, numbers, legal sections) so
        // the Phase 5 AI pipeline produces meaningful derived data.
        const makePdf = (title: string, lines: string[]): Buffer => {
          const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
          const body = [
            "BT /F1 14 Tf 1 0 0 1 60 780 Tm (DEMO / SYNTHETIC DOCUMENT - NOT A REAL LEGAL RECORD) Tj",
            "BT /F1 12 Tf",
            ...lines.map((l, i) => `1 0 0 1 60 ${745 - i * 20} Tm (${esc(l)}) Tj`),
            "ET",
          ].join("\n");
          const content = body;
          const objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
          ];
          let pdf = "%PDF-1.4\n";
          const offsets: number[] = [];
          objects.forEach((obj, i) => {
            offsets.push(Buffer.byteLength(pdf, "latin1"));
            pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
          });
          const xrefStart = Buffer.byteLength(pdf, "latin1");
          pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
          for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
          pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
          return Buffer.from(pdf, "latin1");
        };

        // Scanned-style PDF: text is rasterized into a JPEG page image and
        // wrapped as a single-page image-only PDF — pdftotext finds NO native
        // text, so the Phase 5 extraction pipeline takes the OCR path
        // (pdftoppm → tesseract), demonstrating genuine OCR (spec §6/§7).
        const makeScannedPdf = async (lines: string[]): Promise<Buffer> => {
          const sharp = (await import("sharp")).default;
          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const svg = `<svg width="1240" height="1754" xmlns="http://www.w3.org/2000/svg">
            <rect width="1240" height="1754" fill="#ffffff"/>
            ${lines.map((l, i) => `<text x="90" y="${130 + i * 46}" font-size="31" font-family="DejaVu Sans, sans-serif" fill="#111111">${esc(l)}</text>`).join("\n            ")}
          </svg>`;
          const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
          const content = "q\n612 0 0 864 0 0\ncm\n/Im0 Do\nQ";
          // Object bodies in order: [1]=Catalog [2]=Pages [3]=Page [4]=Image(+jpeg) [5]=Contents
          const obj1 = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1");
          const obj2 = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1");
          const obj3 = Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 864] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n", "latin1");
          const obj4Head = Buffer.from(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1");
          const obj4Tail = Buffer.from("\nendstream\nendobj\n", "latin1");
          const obj5 = Buffer.from(`5 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`, "latin1");
          const parts = [Buffer.from("%PDF-1.4\n", "latin1"), obj1, obj2, obj3, obj4Head, jpeg, obj4Tail, obj5];
          const offsets: number[] = [];
          let pdfChunks: Buffer[] = parts;
          // compute object starts sequentially (offsets point at "N 0 obj")
          let cursor = Buffer.byteLength("%PDF-1.4\n", "latin1");
          offsets.push(cursor); // obj1
          cursor += obj1.length;
          offsets.push(cursor); // obj2
          cursor += obj2.length;
          offsets.push(cursor); // obj3
          cursor += obj3.length;
          offsets.push(cursor); // obj4
          cursor += obj4Head.length + jpeg.length + obj4Tail.length;
          offsets.push(cursor); // obj5
          cursor += obj5.length;
          const xrefStart = cursor;
          pdfChunks = parts;
          const header = Buffer.from("%PDF-1.4\n", "latin1");
          let xref = `xref\n0 6\n0000000000 65535 f \n`;
          for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
          xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
          return Buffer.concat([header, ...pdfChunks, Buffer.from(xref, "latin1")]);
        };

        // The forensic report ships as a SCANNED-style document (image-only
        // PDF) so the seeded demo exercises the OCR pipeline end to end.
        const scannedForensicPdf = await makeScannedPdf([
          "DEMO / SYNTHETIC DOCUMENT - NOT A REAL LEGAL RECORD",
          "Forensic Science Laboratory Indore",
          "Laboratory Report No. FSL/EXP/2026/0091",
          "Referred by: Betma Police Station, case CASE-MP-IND-2026-000001.",
          "Exhibit one: mobile handset, IMEI 123456789012345, sealed parcel.",
          "The mobile phone was seized on 17 January 2026 as recorded in the",
          "seizure memo from Betma police forwarded with the parcel.",
          "Scientific examination of the handset was carried out on 21 January 2026.",
          "Findings: chat artefacts and call logs consistent with the alleged",
          "fraud flow were recovered from the device memory during examination.",
          "The forensic examination found artefacts linking the handset to the",
          "complainant Mr. Rahul Kumar and the accused Vikram Singh.",
          "Conclusion: examination results support the investigation findings.",
          "This laboratory report is a synthetic demonstration document.",
        ]);

        interface DemoDoc {
          documentId: string;
          title: string;
          documentType: string;
          documentCategory: string;
          classification: string;
          description: string;
          uploaderId: string;
          uploadedDaysAgo: number;
          documentDaysAgo: number;
          referenceNumber?: string;
          tags?: string[];
          pdf: Buffer;
          filename: string;
          mime?: string;
          ext?: string;
        }

        const demoDocs: DemoDoc[] = [
          {
            documentId: "DOC-MP-IND-2026-000001",
            title: "First Information Report — FIR/124/2026",
            documentType: "FIR",
            documentCategory: "CASE_RECORD",
            classification: "RESTRICTED",
            description: "First Information Report registered at Indore Police (synthetic demo document).",
            uploaderId: arjun.id,
            uploadedDaysAgo: 18,
            documentDaysAgo: 19,
            referenceNumber: "FIR/124/2026",
            tags: ["fir", "registration"],
            filename: "FIR-124-2026.pdf",
            pdf: makePdf("FIRST INFORMATION REPORT", [
              "First Information Report No. FIR-00012, registered on 12 January 2026.",
              "Police Station: Betma Police Station, District Indore.",
              "Case reference: CASE-MP-IND-2026-000001 (online financial fraud).",
              "Complainant: Mr. Rahul Kumar, resident of Betma, Indore.",
              "Complainant contact number: +91 98765 43210.",
              "Accused: Vikram Singh and unknown associates operating a fraud call centre.",
              "Sections invoked: Section 66C of the IT Act and Section 420 IPC (demo reference only).",
              "Brief facts as stated by the complainant Rahul Kumar:",
              "On 12 January 2026 the mobile phone was seized by the police at Betma",
              "from the possession of the accused Vikram Singh during a search.",
              "The handset IMEI 123456789012345 was sealed as evidence item one.",
              "Vehicle used by the accused: MH-12-AB-1234 (black sedan).",
              "Investigating officer: Inspector A. Sharma, Betma Police Station.",
              "Witness statement of the complainant was recorded on the same day.",
              "This is a synthetic demonstration document with no legal effect.",
            ]),
          },
          {
            documentId: "DOC-MP-IND-2026-000002",
            title: "Investigation Report — Phase 1",
            documentType: "INVESTIGATION_REPORT",
            documentCategory: "INVESTIGATION",
            classification: "CONFIDENTIAL",
            description: "Interim investigation findings (synthetic demo document).",
            uploaderId: vishnu.id,
            uploadedDaysAgo: 9,
            documentDaysAgo: 10,
            tags: ["investigation", "interim"],
            filename: "Investigation-Report-Phase1.pdf",
            pdf: makePdf("INVESTIGATION REPORT - PHASE 1", [
              "Investigation report for case CASE-MP-IND-2026-000001, phase one.",
              "The investigation team examined the digital trail of the fraud ring.",
              "Accused Vikram Singh operated the call centre from Indore; his associate",
              "his associate Mr. Rahul Kumar Singh assisted with cash collection,",
              "The seized mobile phone and two SIM cards were forwarded to the",
              "Forensic Science Laboratory Indore for examination on 13 January 2026.",
              "Bank statements of the complainant Mr. Rahul Kumar were obtained and",
              "ten fraudulent transactions totalling Rs 4,50,000 were identified.",
              "A court hearing for custody remand was held on 20 January 2026.",
              "Pending: forensic confirmation of the seized devices.",
              "This is a synthetic demonstration document with no legal effect.",
            ]),
          },
          {
            documentId: "DOC-MP-IND-2026-000003",
            title: "Forensic Report — Device Analysis",
            documentType: "FORENSIC_REPORT",
            documentCategory: "FORENSIC",
            classification: "RESTRICTED",
            description: "Scanned copy of the forensic examination report received from FSL (synthetic demo document).",
            uploaderId: vishnu.id,
            uploadedDaysAgo: 4,
            documentDaysAgo: 5,
            referenceNumber: "FSL/EXP/2026/0091",
            tags: ["forensics", "devices"],
            filename: "Forensic-Report-Device-Analysis.pdf",
            pdf: scannedForensicPdf, // image-only (scanned-style) — exercises the OCR pipeline
          },
          {
            documentId: "DOC-MP-IND-2026-000004",
            title: "Forensic Report — Supplement",
            documentType: "FORENSIC_REPORT",
            documentCategory: "FORENSIC",
            classification: "INTERNAL",
            description: "Supplementary findings adding information to DOC-MP-IND-2026-000003 (synthetic demo document).",
            uploaderId: vishnu.id,
            uploadedDaysAgo: 2,
            documentDaysAgo: 2,
            tags: ["forensics", "supplement"],
            filename: "Forensic-Report-Supplement.pdf",
            pdf: makePdf("FORENSIC REPORT - SUPPLEMENT", [
              "Supplement to: DOC-MP-IND-2026-000003 (Device Analysis).",
              "Laboratory: Forensic Science Laboratory Indore.",
              "Additional extraction of the SIM card paired with the handset was",
              "completed on 22 January 2026 during a supplementary examination.",
              "Recovered contacts associate the device with the fraud call centre.",
              "The original report remains preserved and unchanged.",
              "This is a synthetic demonstration document with no legal effect.",
            ]),
          },
        ];

        // Phase 5 — Hindi witness statement (plain text, Devanagari) to
        // demonstrate the multilingual foundation (spec §54) through the
        // real extraction + language-detection pipeline.
        const hindiStatement = Buffer.from(
          [
            "DEMO / SYNTHETIC DOCUMENT - NOT A REAL LEGAL RECORD",
            "गवाही वक्तव्य (विक्षिप्त डेमो)",
            "मैं राहुल कुमार, निवासी बेटमा, इंदौर, यह बताना चाहता हूँ कि",
            "मेरा मोबाइल फोन 12 जनवरी 2026 को पुलिस द्वारा जब्त किया गया था।",
            "आरोपी विक्रम सिंह को पुलिस ने उसी दिन गिरफ्तार किया।",
            "मेरा संपर्क नंबर +91 98765 43210 है।",
            "यह कथन बेटमा पुलिस स्टेशन में दर्ज किया गया।",
            "(यह एक सिंथेटिक डेमो दस्तावेज़ है — कोई कानूनी प्रभाव नहीं)",
          ].join("\n"),
          "utf8"
        );
        demoDocs.push({
          documentId: "DOC-MP-IND-2026-000005",
          title: "Witness Statement — Complainant (Hindi)",
          documentType: "WITNESS_STATEMENT",
          documentCategory: "INVESTIGATION",
          classification: "CONFIDENTIAL",
          description: "Hindi-language witness statement recorded at Betma Police Station (synthetic demo document).",
          uploaderId: vishnu.id,
          uploadedDaysAgo: 15,
          documentDaysAgo: 16,
          tags: ["witness", "hindi"],
          filename: "Witness-Statement-Hindi.txt",
          mime: "text/plain",
          ext: "txt",
          pdf: hindiStatement,
        });

        for (const d of demoDocs) {
          const sha256Hash = calculateSha256(d.pdf);
          const { blob, keyReference } = encryptDocument(d.pdf);
          const documentUuid = randomUUID();
          const storageKey = buildStorageKey(case1.id, documentUuid);
          DocumentStorage.ensureRoot();
          await DocumentStorage.put_object(storageKey, blob);

          const committedAt = daysAgo(d.uploadedDaysAgo, 3);
          const doc = await db.caseDocument.create({
            data: {
              documentId: d.documentId,
              caseId: case1.id,
              title: d.title,
              description: d.description,
              documentType: d.documentType,
              documentCategory: d.documentCategory,
              originalFilename: d.filename,
              storedFilename: `${documentUuid}.bin`,
              mimeType: d.mime || "application/pdf",
              fileExtension: d.ext || "pdf",
              fileSize: d.pdf.length,
              storageProvider: "LOCAL_ENCRYPTED_FS",
              storageKey,
              sha256Hash,
              encryptionStatus: "ENCRYPTED_AES_256_GCM",
              keyReference,
              status: "COMMITTED",
              classification: d.classification,
              uploadedByOfficerId: d.uploaderId,
              uploadedByDepartmentId: police.id,
              documentDate: daysAgo(d.documentDaysAgo),
              metadata: JSON.stringify({
                ...(d.referenceNumber ? { referenceNumber: d.referenceNumber } : {}),
                ...(d.tags ? { tags: d.tags } : {}),
              }),
              committedAt,
              createdAt: daysAgo(d.uploadedDaysAgo, 2),
            },
          });
          await db.caseDocument.update({ where: { id: doc.id }, data: { createdAt: daysAgo(d.uploadedDaysAgo, 2) } });

          await db.documentEvent.create({
            data: {
              documentId: doc.id,
              caseId: case1.id,
              eventType: "DOCUMENT_COMMITTED",
              actorOfficerId: d.uploaderId,
              departmentId: police.id,
              result: "SUCCESS",
              metadata: JSON.stringify({ documentId: d.documentId, sha256: sha256Hash, seeded: true }),
              createdAt: committedAt,
            },
          });
          await db.caseEvent.create({
            data: {
              caseId: case1.id,
              eventType: "DOCUMENT_COMMITTED",
              actorOfficerId: d.uploaderId,
              departmentId: police.id,
              targetType: "DOCUMENT",
              targetId: d.documentId,
              description: `Document committed: ${d.title} (${d.documentId})`,
              createdAt: committedAt,
            },
          });

          if (d.documentId === "DOC-MP-IND-2026-000004") {
            const target = await db.caseDocument.findUnique({ where: { documentId: "DOC-MP-IND-2026-000003" } });
            if (target) {
              await db.documentRelationship.create({
                data: {
                  sourceDocumentId: doc.id,
                  targetDocumentId: target.id,
                  relationshipType: "SUPPLEMENT",
                  createdByOfficerId: d.uploaderId,
                  createdAt: committedAt,
                },
              });
              await db.documentEvent.create({
                data: {
                  documentId: doc.id,
                  caseId: case1.id,
                  eventType: "DOCUMENT_SUPPLEMENT_CREATED",
                  actorOfficerId: d.uploaderId,
                  departmentId: police.id,
                  result: "SUCCESS",
                  metadata: JSON.stringify({ documentId: d.documentId, relatedTo: target.documentId, relationshipType: "SUPPLEMENT" }),
                  createdAt: committedAt,
                },
              });
            }
          }
        }
        console.log("  Documents  : 4 demo documents (1 supplement relationship) on CASE-MP-IND-2026-000001");
      }
    }
  }

  // ===========================================================================
  // PHASE 4 — demonstration evidence + genuine audit chain (spec §73).
  // ALL data is synthetic. Evidence is seeded THROUGH THE REAL SERVICES
  // (registerEvidence / changeEvidenceStatus / custody service /
  // linkEvidenceDocument) so the audit hash chain from genesis is
  // authentic — not fabricated rows.
  // ===========================================================================
  {
    const evidenceCount = await db.evidence.count();
    if (evidenceCount === 0) {
      const { registerEvidence, changeEvidenceStatus } = await import("@/lib/evidence/service");
      const { createEvidenceTransferRequest, decideEvidenceTransfer } = await import("@/lib/evidence/custody");
      const { linkEvidenceDocument } = await import("@/lib/evidence/relationships");
      const { permissionsForRole } = await import("@/lib/permissions");

      const seedCtx = (officer: { id: string; officerId: string; name: string; email: string; phone: string | null; designation: string; role: string; status: string; departmentId: string }, department: { id: string; departmentCode: string; name: string; departmentType: string; status: string; stateId: string; districtId: string; cityId: string }) => ({
        sessionId: `seed-${Math.random().toString(36).slice(2, 10)}`,
        officer: { ...officer, lastLoginAt: null },
        department,
        permissions: permissionsForRole(officer.role),
      });

      const meeraCtx = seedCtx(meera, forensics);
      const arjunCtx = seedCtx(arjun, police);
      const rohanOfficer = await db.officer.findUniqueOrThrow({ where: { officerId: "OFF-MP-IND-00003" } });
      const rohanCtx = seedCtx(rohanOfficer, prosecution);
      const vishnuRef = vishnu.officerId;

      // Case 2 needs prosecution as a participant so an evidence custody
      // transfer FSL → Prosecution is a legal destination (spec §44 rule 4).
      const case2 = await db.case.findUniqueOrThrow({ where: { caseId: "CASE-MP-IND-2026-000002" }, select: { id: true, caseId: true, status: true } });
      const case1 = await db.case.findUniqueOrThrow({ where: { caseId: "CASE-MP-IND-2026-000001" }, select: { id: true, caseId: true, status: true } });
      const prosecutionParticipation = await db.caseDepartment.findFirst({
        where: { caseId: case2.id, departmentId: prosecution.id, status: "ACTIVE" },
        select: { id: true },
      });
      if (!prosecutionParticipation) {
        await addParticipation(case2.id, prosecution.id, "PARTICIPATING", 10);
      }

      // Synthetic 1x1 PNG (transparent) — a real, decodable image.
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64"
      );
      // Synthetic MP4: valid ISO-BMFF container header (ftyp box) — the
      // bytes are a container skeleton, NOT playable media (synthetic demo).
      const mp4Bytes = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftypmp42"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("mp42isom"),
        Buffer.from([0x00, 0x00, 0x00, 0x08]),
        Buffer.from("free"),
      ]);

      const day = (d: number) => new Date(Date.now() - d * 86400000);

      // ---- EVD-1: CCTV recording (DIGITAL/VIDEO) on case 2 --------------------
      const evd1 = await registerEvidence({
        ctx: meeraCtx,
        caseRow: case2,
        input: {
          title: "CCTV Recording — Market Premises",
          description: "DEMO: CCTV footage covering the market entrance around the incident window (synthetic container, not playable media).",
          evidenceType: "VIDEO",
          category: "CCTV footage",
          classification: "RESTRICTED",
          sourceType: "CCTV_SYSTEM",
          sourceReference: "CAM-MP-IND-014 / DVR-7",
          collectionLocation: "Market premises, MG Road, Indore",
          collectedAt: day(14),
          collectedByOfficerId: vishnuRef,
          condition: "Original DVR export, unaltered",
          notes: "Exported under seizure memo (demo).",
          evidenceNumber: "SEIZ/2026/CC-014",
          deviceMetadata: { dvrModel: "DVR-7", channels: "16" },
        },
        file: { buffer: mp4Bytes, originalFilename: "CCTV.mp4", declaredMimeType: "video/mp4" },
      });
      await changeEvidenceStatus({
        ctx: meeraCtx,
        caseRow: case2,
        evidence: { id: (evd1.evidence as { id: string }).id, evidenceId: evd1.evidence.evidenceId, status: "REGISTERED", title: evd1.evidence.title },
        requestedStatus: "IN_CUSTODY",
        reason: "Logged into FSL digital evidence locker.",
      });

      // ---- EVD-2: seized mobile phone (physical DEVICE) on case 2 -------------
      const evd2 = await registerEvidence({
        ctx: meeraCtx,
        caseRow: case2,
        input: {
          title: "Seized Mobile Phone — Samsung Galaxy M32",
          description: "DEMO: handset seized from the accused; faraday-bagged on collection (physical item, no digital content stored).",
          evidenceType: "DEVICE",
          category: "Mobile handset",
          classification: "CONFIDENTIAL",
          sourceType: "POLICE_SEIZURE",
          sourceReference: "SEIZ/2026/0117",
          collectionLocation: "Indore, seizure site",
          collectedAt: day(16),
          collectedByOfficerId: vishnuRef,
          condition: "Good; power off on receipt, bagged",
          notes: "IMEI recorded on the seizure memo (demo).",
          evidenceNumber: "SEIZ/2026/0117",
          deviceMetadata: { manufacturer: "Samsung", model: "Galaxy M32", serialNumber: "DEMO-SN-0000001" },
        },
        file: null,
      });
      await changeEvidenceStatus({
        ctx: meeraCtx,
        caseRow: case2,
        evidence: { id: (evd2.evidence as { id: string }).id, evidenceId: evd2.evidence.evidenceId, status: "REGISTERED", title: evd2.evidence.title },
        requestedStatus: "IN_CUSTODY",
        reason: "Stored in FSL physical evidence locker.",
      });

      // ---- EVD-3: scene photograph (DIGITAL/IMAGE) on case 2 ------------------
      await registerEvidence({
        ctx: meeraCtx,
        caseRow: case2,
        input: {
          title: "Scene Photograph — Device Packaging",
          description: "DEMO: photograph of the sealed device packaging at receipt (1x1 synthetic PNG).",
          evidenceType: "IMAGE",
          category: "Scene photograph",
          classification: "INTERNAL",
          sourceType: "FORENSIC_LAB",
          sourceReference: "FSL/PH/2026/0091",
          collectionLocation: "FSL receiving bay",
          collectedAt: day(11),
          condition: "N/A — photograph",
        },
        file: { buffer: pngBytes, originalFilename: "scene-photo.png", declaredMimeType: "image/png" },
      });

      // ---- EVD-4: seized hard disk (physical DEVICE) on case 1 ----------------
      const evd4 = await registerEvidence({
        ctx: arjunCtx,
        caseRow: case1,
        input: {
          title: "Seized Hard Disk Drive — 1TB",
          description: "DEMO: internal HDD seized from the office workstation (physical item; forensic imaging handled offline in this demo).",
          evidenceType: "DEVICE",
          category: "Storage media",
          classification: "RESTRICTED",
          sourceType: "POLICE_SEIZURE",
          sourceReference: "SEIZ/2026/0098",
          collectionLocation: "Office premises, Palasia Square, Indore",
          collectedAt: day(24),
          collectedByOfficerId: vishnuRef,
          condition: "Sealed evidence bag, no visible damage",
          evidenceNumber: "SEIZ/2026/0098",
          deviceMetadata: { manufacturer: "Seagate", capacity: "1TB", serialNumber: "DEMO-SN-0000002" },
        },
        file: null,
      });
      await changeEvidenceStatus({
        ctx: arjunCtx,
        caseRow: case1,
        evidence: { id: (evd4.evidence as { id: string }).id, evidenceId: evd4.evidence.evidenceId, status: "REGISTERED", title: evd4.evidence.title },
        requestedStatus: "IN_CUSTODY",
        reason: "Stored in police malkhana locker B.",
      });

      // ---- Evidence-document relationship (spec §20): forensic report DESCRIBES
      //      the seized disk (both belong to case 1) ----------------------------
      const forensicDoc = await db.caseDocument.findUnique({ where: { documentId: "DOC-MP-IND-2026-000003" }, select: { id: true, documentId: true } });
      if (forensicDoc) {
        await linkEvidenceDocument({
          ctx: arjunCtx,
          access: { level: "manage", view: true, manage: true, isCustodianSide: true, isOriginSide: true, assigned: false, reasons: ["seed"] },
          caseRow: case1,
          evidence: { id: (evd4.evidence as { id: string }).id, evidenceId: evd4.evidence.evidenceId, classification: "RESTRICTED" },
          input: { documentId: forensicDoc.documentId, relationshipType: "DESCRIBES", note: "FSL examination report for the seized disk." },
        });
      }

      // ---- Custody transfer with full history (spec §73 steps 10-13):
      //      CCTV recording FSL → Prosecution, requested by meera, accepted
      //      by Rohan Verma (Prosecution DEPARTMENT_ADMIN) via the REAL
      //      custody service — audit events chained in the same transactions.
      await createEvidenceTransferRequest({
        ctx: meeraCtx,
        caseRow: case2,
        evidence: {
          id: (evd1.evidence as { id: string }).id,
          evidenceId: evd1.evidence.evidenceId,
          title: evd1.evidence.title,
          status: "IN_CUSTODY",
          currentCustodianDepartmentId: forensics.id,
        },
        input: {
          toDepartmentId: prosecution.id,
          toOfficerId: rohanOfficer.officerId,
          reason: "Footage required for trial preparation by the prosecution team.",
          notes: "Chain-of-custody demo transfer (seed).",
        },
      });
      const pendingTransfer = await db.evidenceTransfer.findFirst({
        where: { evidenceId: (evd1.evidence as { id: string }).id, status: "REQUESTED" },
        select: { transferId: true },
      });
      if (pendingTransfer) {
        await decideEvidenceTransfer({ ctx: rohanCtx, transferRef: pendingTransfer.transferId, action: "ACCEPT" });
      }

      console.log("  Evidence   : 4 demo items (2 digital, 2 physical; 1 accepted custody transfer; 1 document relationship)");
    }
  }

  // ===========================================================================
  // PHASE 5 — AI model registry + REAL AI processing + human verification.
  // The AI pipeline runs through the REAL services (enqueueAIJob → worker →
  // stages → audit chain), then a HUMAN review pass records genuine review
  // decisions through the review service. No AI result rows are fabricated.
  // ===========================================================================
  {
    // ---- model registry (spec §28) — inspectable inventory of models ----
    const registryEntries: Array<{ provider: string; modelName: string; modelVersion: string | null; task: string; languageSupport: string[]; enabled: boolean; configuration?: Record<string, unknown> }> = [
      { provider: "heuristic", modelName: "rule-baseline-v1", modelVersion: "1.0.0", task: "CLASSIFICATION", languageSupport: ["en"], enabled: true, configuration: { kind: "deterministic keyword scoring — local baseline, not a neural model" } },
      { provider: "heuristic", modelName: "rule-baseline-v1", modelVersion: "1.0.0", task: "ENTITY_EXTRACTION", languageSupport: ["en"], enabled: true, configuration: { kind: "regex + gazetteer extraction — local baseline" } },
      { provider: "heuristic", modelName: "rule-baseline-v1", modelVersion: "1.0.0", task: "SUMMARIZATION", languageSupport: ["en"], enabled: true, configuration: { kind: "extractive sentence scoring — local baseline" } },
      { provider: "heuristic", modelName: "rule-baseline-v1", modelVersion: "1.0.0", task: "QUESTION_ANSWERING", languageSupport: ["en"], enabled: true, configuration: { kind: "strictly extractive grounded answering — local baseline" } },
      { provider: "heuristic", modelName: "script-stopword-v1", modelVersion: "1.0.0", task: "LANGUAGE_DETECTION", languageSupport: ["en", "hi"], enabled: true },
      { provider: "heuristic", modelName: "poppler-pdftotext", modelVersion: "1.0.0", task: "TEXT_EXTRACTION", languageSupport: ["en", "hi"], enabled: true, configuration: { binary: "pdftotext (poppler-utils)" } },
      { provider: "tesseract", modelName: "tesseract-cli", modelVersion: "5.x", task: "OCR", languageSupport: ["en"], enabled: true, configuration: { installedPacks: ["eng"], note: "hin pack not installed in this environment — Hindi OCR reports AI_LANGUAGE_PACK_UNAVAILABLE instead of pretending" } },
      { provider: "local-hashing", modelName: "hashed-bow-256d", modelVersion: "1.0.0", task: "EMBEDDING", languageSupport: ["en", "hi"], enabled: true, configuration: { dimension: 256, kind: "hashed lexical bag-of-features — development baseline; pgvector/neural embeddings are the production path" } },
      { provider: "zai", modelName: "glm-4.5-air", modelVersion: "2026-01", task: "SUMMARIZATION", languageSupport: ["en", "hi"], enabled: false, configuration: { external: true, note: "INACTIVE until an administrator enables external processing (LOCAL_ONLY off) — audited" } },
      { provider: "zai", modelName: "glm-4.5-air", modelVersion: "2026-01", task: "QUESTION_ANSWERING", languageSupport: ["en", "hi"], enabled: false, configuration: { external: true } },
      { provider: "zai", modelName: "glm-4.5-air", modelVersion: "2026-01", task: "CLASSIFICATION", languageSupport: ["en", "hi"], enabled: false, configuration: { external: true } },
      { provider: "zai", modelName: "glm-4.5-air", modelVersion: "2026-01", task: "ENTITY_EXTRACTION", languageSupport: ["en", "hi"], enabled: false, configuration: { external: true } },
    ];
    for (const e of registryEntries) {
      await db.aIModelRegistry.upsert({
        where: { provider_modelName_task: { provider: e.provider, modelName: e.modelName, task: e.task } },
        create: { ...e, languageSupport: JSON.stringify(e.languageSupport), configuration: e.configuration ? JSON.stringify(e.configuration) : null },
        update: { enabled: e.enabled, modelVersion: e.modelVersion, languageSupport: JSON.stringify(e.languageSupport), configuration: e.configuration ? JSON.stringify(e.configuration) : null },
      });
    }
    await db.aIConfig.upsert({ where: { id: "SINGLETON" }, create: { id: "SINGLETON" }, update: {} });

    // ---- run the real AI pipeline on the demo case documents ----
    const jobCount = await db.aIProcessingJob.count();
    if (jobCount === 0) {
      const case1 = await db.case.findUniqueOrThrow({ where: { caseId: "CASE-MP-IND-2026-000001" }, select: { id: true, caseId: true } });
      const arjunOfficer = await db.officer.findUniqueOrThrow({ where: { email: "arjun.sharma@demo.gov.in" } });
      const policeDept = await db.department.findUniqueOrThrow({ where: { departmentCode: "DEPT-MP-IND-POL-001" } });

      const { enqueueAIJob, drainQueue } = await import("@/lib/ai/jobs");
      const aiCtx = {
        sessionId: "seed-ai",
        officer: {
          id: arjunOfficer.id,
          officerId: arjunOfficer.officerId,
          name: arjunOfficer.name,
          email: arjunOfficer.email,
          phone: arjunOfficer.phone,
          designation: arjunOfficer.designation,
          role: arjunOfficer.role,
          status: arjunOfficer.status,
          departmentId: arjunOfficer.departmentId,
          lastLoginAt: null,
        },
        department: {
          id: policeDept.id,
          departmentCode: policeDept.departmentCode,
          name: policeDept.name,
          departmentType: policeDept.departmentType,
          status: policeDept.status,
          stateId: policeDept.stateId,
          districtId: policeDept.districtId,
          cityId: policeDept.cityId,
        },
        permissions: [],
      };

      const docIds = [
        "DOC-MP-IND-2026-000001",
        "DOC-MP-IND-2026-000002",
        "DOC-MP-IND-2026-000003",
        "DOC-MP-IND-2026-000004",
        "DOC-MP-IND-2026-000005",
      ];
      for (const docRef of docIds) {
        const doc = await db.caseDocument.findUnique({ where: { documentId: docRef }, select: { id: true, documentId: true } });
        if (!doc) continue;
        await enqueueAIJob({
          ctx: aiCtx as never,
          jobType: "FULL_ANALYSIS",
          documentId: doc.id,
          documentRef: doc.documentId,
          caseInternalId: case1.id,
          caseRef: case1.caseId,
        });
      }
      await drainQueue();

      // ---- HUMAN verification pass through the REAL review service ----
      const { reviewAIResult } = await import("@/lib/ai/review");
      const reviewCtx = { ...aiCtx, sessionId: "seed-review" } as never;

      // 1) Accept the forensic report classification suggestion
      const forensic = await db.caseDocument.findUnique({ where: { documentId: "DOC-MP-IND-2026-000003" }, select: { id: true, documentId: true } });
      if (forensic) {
        const cls = await db.aIDocumentClassification.findFirst({
          where: { documentId: forensic.id, reviewStatus: "PENDING" },
          orderBy: { createdAt: "desc" },
        });
        if (cls) {
          await reviewAIResult(reviewCtx, { resultType: "CLASSIFICATION", resultId: cls.id, action: "VERIFIED", comment: "Suggestion matches the registered document type." });
        }
      }

      // 2) Verify two FIR entities (person + phone) — HUMAN VERIFIED demo state
      const fir = await db.caseDocument.findUnique({ where: { documentId: "DOC-MP-IND-2026-000001" }, select: { id: true } });
      if (fir) {
        const toVerify = await db.extractedEntity.findMany({
          where: { documentId: fir.id, reviewStatus: "PENDING", entityType: { in: ["PERSON", "PHONE_NUMBER", "EVIDENCE_ID"] } },
          orderBy: { confidence: "desc" },
          take: 2,
        });
        for (const e of toVerify) {
          await reviewAIResult(reviewCtx, { resultType: "ENTITY", resultId: e.id, action: "VERIFIED", comment: "Cross-checked against the case record." });
        }
      }

      // 3) Confirm the AI REFERENCE suggestion supplement → forensic report
      const supplement = await db.caseDocument.findUnique({ where: { documentId: "DOC-MP-IND-2026-000004" }, select: { id: true } });
      if (supplement) {
        const rel = await db.aIRelationshipSuggestion.findFirst({
          where: { sourceDocumentId: supplement.id, relationshipType: "REFERENCE", status: "SUGGESTED" },
          orderBy: { createdAt: "desc" },
        });
        if (rel) {
          await reviewAIResult(reviewCtx, { resultType: "RELATIONSHIP", resultId: rel.id, action: "VERIFIED", comment: "Confirmed — the supplement explicitly references the original report." });
        }
      }

      const jobsDone = await db.aIProcessingJob.groupBy({ by: ["status"], _count: { _all: true } });
      const statusLine = jobsDone.map((g) => `${g.status}:${g._count._all}`).join(" ");
      console.log(`  AI         : model registry seeded; 5 documents processed through the real pipeline (${statusLine}); human review pass complete`);
    }
  }

  // ===========================================================================
  // PHASE 8 — Integration seed: schema/mapping versions + MOCK/SANDBOX
  // connections with credentials through the secret abstraction.
  // Everything here is clearly labeled MOCK/SANDBOX (spec §1/§50/§51/§71):
  // NO real government system is contacted or claimed to be connected.
  // ===========================================================================
  {
    const seedCtx = { officerId: sysadminOfficer.id, officerName: sysadminOfficer.name };

    // ---- Field mappings (versioned DATA, spec §18) -------------------------
    const caseMappings = [
      { from: "externalCaseId", to: "externalCaseId", type: "string" as const, required: true, maxLen: 120 },
      { from: "caseNumber", to: "externalCaseNumber", type: "string" as const, maxLen: 64 },
      { from: "title", to: "title", type: "string" as const, required: true, maxLen: 200 },
      { from: "description", to: "description", type: "string" as const, maxLen: 4000 },
      { from: "caseType", to: "caseType", type: "enum" as const, required: true, enumValues: ["CRIMINAL", "CYBERCRIME", "WOMEN_SAFETY", "CHILD_RELATED", "FINANCIAL", "ORGANIZED_CRIME", "MISSING_PERSON", "FORENSIC", "OTHER"] },
      { from: "priority", to: "priority", type: "enum" as const, default: "NORMAL", enumValues: ["LOW", "NORMAL", "HIGH", "CRITICAL"] },
      { from: "investigatingOfficer.badge", to: "officerBadge", type: "string" as const, maxLen: 40, sensitive: true, note: "Officer identity is mapped only to a platform officer account after review — never auto-linked." },
      { from: "updatedAt", to: "externalUpdatedAt", type: "date" as const },
    ];
    const documentMappings = [
      { from: "externalDocumentId", to: "externalDocumentId", type: "string" as const, required: true, maxLen: 120 },
      { from: "title", to: "title", type: "string" as const, required: true, maxLen: 200 },
      { from: "documentType", to: "documentType", type: "enum" as const, default: "OTHER", enumValues: ["FIR", "CASE_DIARY", "WITNESS_STATEMENT", "INVESTIGATION_REPORT", "FORENSIC_REPORT", "CHARGE_SHEET", "PROSECUTION_DOCUMENT", "COURT_DOCUMENT", "COURT_ORDER", "JUDGMENT", "LEGAL_NOTICE", "CORRESPONDENCE", "IDENTITY_DOCUMENT", "EVIDENCE_REPORT", "OTHER"] },
      { from: "classification", to: "classification", type: "enum" as const, default: "INTERNAL", enumValues: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"] },
      { from: "documentDate", to: "documentDate", type: "date" as const },
    ];
    const evidenceMappings = [
      { from: "externalEvidenceId", to: "externalEvidenceId", type: "string" as const, required: true, maxLen: 120 },
      { from: "title", to: "title", type: "string" as const, required: true, maxLen: 200 },
      { from: "evidenceType", to: "evidenceType", type: "enum" as const, default: "OTHER", enumValues: ["PHYSICAL", "DIGITAL", "DOCUMENTARY", "AUDIO", "VIDEO", "IMAGE", "FORENSIC_SAMPLE", "DEVICE", "OTHER"] },
      { from: "classification", to: "classification", type: "enum" as const, default: "RESTRICTED", enumValues: ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"] },
      { from: "collectedAt", to: "collectedAt", type: "date" as const },
    ];

    for (const providerType of ["CCTNS", "E_FORENSICS", "E_PROSECUTION", "E_COURTS", "E_PRISONS", "ICJS"]) {
      // Schema versions (spec §19): only 1.0 registered/supported per provider.
      await db.integrationSchemaVersion.upsert({
        where: { providerType_schemaName_schemaVersion: { providerType, schemaName: "case_exchange", schemaVersion: "1.0" } },
        create: { providerType, schemaName: "case_exchange", schemaVersion: "1.0", supported: true, minMappingVersion: 1, notes: "MOCK sandbox schema — the only version this platform has ever seen." },
        update: {},
      });
      for (const [mappingName, mappings] of [["case_import", caseMappings], ["document_import", documentMappings], ["evidence_import", evidenceMappings]] as const) {
        await db.integrationMappingVersion.upsert({
          where: { providerType_mappingName_mappingVersion: { providerType, mappingName, mappingVersion: 1 } },
          create: { providerType, mappingName, mappingVersion: 1, mappingJson: JSON.stringify(mappings), isActive: true },
          update: { mappingJson: JSON.stringify(mappings), isActive: true },
        });
      }
    }

    // ---- Connections (provider registry targets, §5/§6) --------------------
    // credentials are stored through the secret abstraction — the DB rows
    // hold only references. Values are clearly-labeled MOCK fixtures.
    const connectionDefs = [
      { connectionId: "CONN-MP-IND-2026-000001", providerType: "CCTNS", displayName: "CCTNS — Indore Police (MOCK SANDBOX)", deptId: police.id, enabled: true, config: { autoApproveLowRisk: true, importCaseDocuments: true, importCaseEvidence: true } },
      { connectionId: "CONN-MP-IND-2026-000002", providerType: "E_FORENSICS", displayName: "e-Forensics — FSL (MOCK SANDBOX)", deptId: forensics.id, enabled: true, config: { autoApproveLowRisk: true } },
      { connectionId: "CONN-MP-IND-2026-000003", providerType: "E_PROSECUTION", displayName: "e-Prosecution — Indore (MOCK SANDBOX)", deptId: prosecution.id, enabled: true, config: { autoApproveLowRisk: true } },
      { connectionId: "CONN-MP-IND-2026-000004", providerType: "E_COURTS", displayName: "e-Courts/CIS — Indore (MOCK SANDBOX)", deptId: platform.id, enabled: true, config: {} },
      { connectionId: "CONN-MP-IND-2026-000005", providerType: "E_PRISONS", displayName: "e-Prisons — Indore (MOCK SANDBOX)", deptId: platform.id, enabled: true, config: {} },
      { connectionId: "CONN-MP-IND-2026-000006", providerType: "ICJS", displayName: "ICJS — Inter-operable layer (MOCK SANDBOX)", deptId: platform.id, enabled: true, config: {} },
    ];
    let seededConnections = 0;
    for (const def of connectionDefs) {
      const existing = await db.integrationConnection.findUnique({ where: { connectionId: def.connectionId } });
      if (existing) continue;
      await db.integrationConnection.create({
        data: {
          connectionId: def.connectionId,
          providerType: def.providerType,
          providerMode: "MOCK", // every seeded connection is a simulator (§71)
          displayName: def.displayName,
          environment: "SANDBOX",
          status: "CONFIGURED",
          authenticationType: "API_KEY",
          baseUrlReference: `mock://${def.providerType.toLowerCase().replace(/_/g, "")}/sandbox`,
          ownerDepartmentId: def.deptId,
          scope: "DEPARTMENT",
          allowedOperations: "read,test,import,export",
          configJson: JSON.stringify(def.config),
          enabled: def.enabled,
          createdByOfficerId: sysadminOfficer.id,
        },
      });
      await integrationCredentialService.setCredentials(def.connectionId, {
        authType: "API_KEY",
        apiKey: `mock-${def.providerType.toLowerCase()}-sandbox-key-0123456789`,
        webhookSecret: `mock-${def.providerType.toLowerCase()}-whsec-0123456789abcdef`,
      });
      await db.integrationConnection.update({ where: { connectionId: def.connectionId }, data: { credentialRef: `secret://integrations/${def.connectionId}`, hasWebhookSecret: true } });
      seededConnections += 1;
    }
    void seedCtx;
    if (seededConnections > 0) {
      console.log(`  Integration: 6 schema-version rows, 18 mapping versions, ${seededConnections} MOCK/SANDBOX connections (credentials in encrypted secret store, DB holds references only)`);
    }
  }

  // ---- PHASE 6 — build case knowledge graphs via the REAL sync
  // service (deterministic, confirmed-data-only projection). The
  // seed exercises the production code path — no separate seed-only
  // graph builder exists. ----
  const cases = await db.case.findMany({ select: { caseId: true, title: true }, orderBy: { caseId: "asc" } });
  let graphsSynced = 0;
  for (const c of cases) {
    try {
      const { syncCaseGraph } = await import("../src/lib/graph/graph-sync");
      const result = await syncCaseGraph(c.caseId, { triggeredByOfficerId: sysadminOfficer.id });
      graphsSynced += 1;
      console.log(`  Graph ${c.caseId}: ${result.nodeCount} nodes / ${result.edgeCount} edges (v${result.syncVersion})`);
    } catch (err) {
      console.log(`  Graph ${c.caseId}: SYNC FAILED — ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  if (graphsSynced > 0) {
    console.log(`  Graph: ${graphsSynced}/${cases.length} case knowledge graphs projected (human-confirmed data only)`);
  }

  console.log("============================================================");
  console.log("Phase 1 + Phase 2 seed complete  [DEMO / DEVELOPMENT DATA]");
  console.log(`  Country : ${india.name} (${india.code})`);
  console.log(`  States  : ${mp.name}, ${ka.name}`);
  console.log("  Departments: 5 (Police, Forensics, Prosecution, Bhopal Police, Platform Admin)");
  console.log("  Officers   : 8");
  console.log("  Cases      : 6 (incl. 1 closed, 1 pending transfer, multi-participant demos)");
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
