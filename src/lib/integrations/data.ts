import { createHash } from "crypto";

// ============================================================
// Phase 8 — MOCK external dataset (spec §50/§51).
//
// CLEARLY LABELED TEST DATA: MOCK-CASE-001 … MOCK-CASE-003 etc.
// These records simulate an external departmental system for the
// adapter demo and tests. They are NEVER mixed with production
// records: every import carries provider provenance and the UI
// shows Provider mode: MOCK (§71).
//
// Document bytes are small, valid, synthetic files (real PDF/TXT
// magic bytes) so imports exercise the REAL Phase 3 validation,
// hashing, encryption and storage pipeline.
// ============================================================

export interface MockExternalDocument {
  externalDocumentId: string;
  title: string;
  documentType: string;
  classification: string;
  documentDate: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
  sizeBytes: number;
  sourceHash: string;
}

export interface MockExternalEvidence {
  externalEvidenceId: string;
  title: string;
  description: string;
  evidenceType: string;
  classification: string;
  sourceCustodian: string;
  sourceDepartment: string;
  collectionLocation: string;
  collectedAt: string;
  custodyTrail: { available: boolean; events?: Array<{ action: string; actor?: string; at?: string }> };
  currentExternalHolder?: string;
}

export interface MockExternalCase {
  externalCaseId: string;
  externalCaseNumber: string;
  title: string;
  description: string;
  caseType: string;
  priority: string;
  status: string;
  district: string;
  state: string;
  investigatingOfficer: { name: string; badge: string };
  schemaVersion: string;
  updatedAt: string;
  documents: MockExternalDocument[];
  evidence: MockExternalEvidence[];
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Minimal but structurally valid PDF (same approach as the platform
// test suites) — passes Phase 3 magic-byte validation.
export function makeMockPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const body = ["BT /F1 12 Tf", ...lines.map((l, i) => `1 0 0 1 60 ${760 - i * 20} Tm (${esc(l)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`,
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
}

function doc(
  id: string,
  title: string,
  documentType: string,
  classification: string,
  daysAgo: number,
  content: Buffer,
  filename: string,
  mimeType: string,
  corruptHash = false
): MockExternalDocument {
  const hash = sha256Hex(content);
  return {
    externalDocumentId: id,
    title,
    documentType,
    classification,
    documentDate: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    filename,
    mimeType,
    contentBase64: content.toString("base64"),
    sizeBytes: content.length,
    // corruptHash=true simulates an external system reporting a WRONG
    // integrity hash — import must BLOCK (spec §55).
    sourceHash: corruptHash ? sha256Hex(`${hash}-corrupted`) : hash,
  };
}

function mkCase(c: MockExternalCase): MockExternalCase {
  return c;
}

const FIR_001 = makeMockPdf([
  "FIRST INFORMATION REPORT — MOCK SANDBOX DATA",
  "FIR 221/2026, P.S. Vijay Nagar, District Indore (M.P.)",
  "Offences u/s 379 IPC — theft of truck MP-09-GX-4471",
  "Complainant: Ramesh Yadav, Transport Nagar, Indore",
  "This document is a MOCK fixture for integration testing.",
]);

const SEIZURE_001 = Buffer.from(
  [
    "SEIZURE MEMO (MOCK SANDBOX DATA) — CCTNS-CASE-892341",
    "Seized: one (1) truck MP-09-GX-4471, chassis  MAT4471982MX2",
    "Recovered from: Agra-Mumbai Bypass, near Rau, Indore",
    "Witnesses: 1. Const. R. Ahir 2. Head Const. S. Patel",
    "This is synthetic content for the mock provider dataset.",
  ].join("\n"),
  "utf8"
);

export const MOCK_CASES: MockExternalCase[] = [
  mkCase({
    externalCaseId: "MOCK-CASE-001",
    externalCaseNumber: "CCTNS-CASE-892341",
    title: "State vs Anil Kumar — Truck Theft (FIR 221/2026)",
    description:
      "MOCK SANDBOX RECORD. Motor vehicle theft registered at P.S. Vijay Nagar; stolen truck recovered and accused arrested while attempting resale.",
    caseType: "CRIMINAL",
    priority: "HIGH",
    status: "UNDER_INVESTIGATION",
    district: "Indore",
    state: "Madhya Pradesh",
    investigatingOfficer: { name: "Inspector R. Chouhan", badge: "MOCK-IO-7712" },
    schemaVersion: "1.0",
    updatedAt: "2026-09-15T04:30:00.000Z",
    documents: [
      doc("MOCK-DOCUMENT-001", "FIR 221/2026 — Truck Theft", "FIR", "RESTRICTED", 20, FIR_001, "mock-fir-221-2026.pdf", "application/pdf"),
      doc("MOCK-DOCUMENT-002", "Seizure Memo — Truck MP-09-GX-4471", "INVESTIGATION_REPORT", "CONFIDENTIAL", 12, SEIZURE_001, "mock-seizure-memo.txt", "text/plain"),
    ],
    evidence: [
      {
        externalEvidenceId: "MOCK-EVIDENCE-001",
        title: "Seized truck MP-09-GX-4471 (MOCK fixture)",
        description: "MOCK SANDBOX RECORD. Physical evidence item — recovered stolen vehicle held at P.S. Vijay Nagar yard.",
        evidenceType: "PHYSICAL",
        classification: "RESTRICTED",
        sourceCustodian: "Inspector R. Chouhan (MOCK-IO-7712)",
        sourceDepartment: "CCTNS Mock Police — Vijay Nagar P.S.",
        collectionLocation: "Agra-Mumbai Bypass, near Rau, Indore",
        collectedAt: "2026-09-08T09:15:00.000Z",
        // No historical custody chain provided by the external system —
        // the platform must record HISTORY_UNAVAILABLE, never invent it (§27).
        custodyTrail: { available: false },
        currentExternalHolder: "Vijay Nagar Police Station Yard (MOCK)",
      },
    ],
  }),
  mkCase({
    externalCaseId: "MOCK-CASE-002",
    externalCaseNumber: "CCTNS-CASE-901188",
    title: "Motor Vehicle Accident Inquiry — Bypass Road",
    description: "MOCK SANDBOX RECORD. Injury accident inquiry with pending statements.",
    caseType: "CRIMINAL",
    priority: "NORMAL",
    status: "OPEN",
    district: "Indore",
    state: "Madhya Pradesh",
    investigatingOfficer: { name: "Sub-Inspector D. Patidar", badge: "MOCK-IO-8155" },
    schemaVersion: "1.0",
    updatedAt: "2026-09-10T07:00:00.000Z",
    documents: [
      doc(
        "MOCK-DOCUMENT-003",
        "Scene Sketch & Observation Memo (MOCK)",
        "INVESTIGATION_REPORT",
        "INTERNAL",
        9,
        Buffer.from("MOCK scene observation memo for CCTNS-CASE-901188. Synthetic text used for import testing only.", "utf8"),
        "mock-scene-memo.txt",
        "text/plain"
      ),
    ],
    evidence: [],
  }),
  mkCase({
    externalCaseId: "MOCK-CASE-003",
    externalCaseNumber: "CCTNS-CASE-915770",
    title: "ABC Investigation",
    description: "MOCK SANDBOX RECORD. Minimal fixture used for conflict-detection testing (central title differs).",
    caseType: "OTHER",
    priority: "NORMAL",
    status: "OPEN",
    district: "Indore",
    state: "Madhya Pradesh",
    investigatingOfficer: { name: "Inspector K. Solanki", badge: "MOCK-IO-9001" },
    schemaVersion: "1.0",
    updatedAt: "2026-09-12T10:00:00.000Z",
    documents: [],
    evidence: [],
  }),
];

/** In-module mutable store — mutations simulate the external system changing (§61 step 19).
 *  Held on globalThis: bundlers may instantiate this module once per route bundle,
 *  and the simulated external system must be ONE shared dataset. */
interface GlobalStore {
  __integrationMockStore?: Map<string, MockExternalCase>;
}
const g = globalThis as unknown as GlobalStore;
const store: Map<string, MockExternalCase> =
  g.__integrationMockStore ?? (g.__integrationMockStore = new Map(MOCK_CASES.map((c) => [c.externalCaseId, structuredClone(c)])));

/** Simulate an external-side change (e.g. title edited at the source system). */
export function mutateMockCase(externalCaseId: string, patch: Partial<Pick<MockExternalCase, "title" | "description" | "priority" | "status">>): boolean {
  const c = store.get(externalCaseId);
  if (!c) return false;
  Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  return true;
}

export function getMockCase(externalCaseId: string): MockExternalCase | null {
  return store.get(externalCaseId) ?? null;
}

export function listMockCases(): MockExternalCase[] {
  return Array.from(store.values());
}
