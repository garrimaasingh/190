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
              "Case: FIR/124/2026 - Demonstration Cybercrime Investigation",
              "Police Station: Indore Cyber Cell",
              "Sections: IT Act 66C/66D, IPC 420 (demo reference only)",
              "Complainant details recorded in the case file.",
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
              "Case: CASE-MP-IND-2026-000001",
              "Summary of digital-trail analysis (synthetic).",
              "Pending forensic confirmation of seized devices.",
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
            pdf: makePdf("FORENSIC EXAMINATION REPORT", [
              "Referred by: Indore Police (Case CASE-MP-IND-2026-000001)",
              "Exhibit: mobile handset analysis (synthetic findings).",
              "Conclusion: artefacts consistent with the alleged fraud flow.",
            ]),
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
              "Additional extraction results (synthetic).",
              "Original report remains preserved and unchanged.",
            ]),
          },
        ];

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
              mimeType: "application/pdf",
              fileExtension: "pdf",
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
