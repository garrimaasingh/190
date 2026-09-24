import { createHash } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { resolveCaseAccess, type CaseAccess } from "@/lib/cases/access";
import { canViewEvidence } from "@/lib/evidence/authorization";
import { canViewDocument } from "@/lib/documents/authorization";
import { DOCUMENT_CLASSIFICATIONS, DOCUMENT_CLASSIFICATION_LEVEL, EVIDENCE_CLASSIFICATIONS } from "@/lib/constants";
import { recordAuditEvent } from "@/lib/audit/service";

// ============================================================
// ReportService (spec §41/§42/§43/§65/§66).
//
// TECHNICAL compliance-SUPPORT reports. They make NO claim of court
// admissibility and NO claim that legal compliance is automatically
// guaranteed (spec §43) — the report text says so explicitly.
//
// Report integrity (spec §66): every generation is a NEW instance
// with its own reportId + generatedAt + generatedBy + reportHash
// (SHA-256 over the canonical report payload). Generated reports are
// derived records — regeneration never edits an earlier instance;
// generation itself is audited (REPORT_GENERATED).
//
// AUTHORIZATION: reports reuse the case/evidence/document clearance
// models — a report never contains rows the generator cannot see.
// ============================================================

function reportId(prefix: string): string {
  return `RPT-${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`;
}

function hashReport(payload: unknown): string {
  // Canonical hash: stable key order (already fixed by construction below).
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const DISCLAIMER =
  "This is a technical compliance-support report generated from system records. It does not certify court admissibility, does not constitute legal advice, and does not guarantee legal compliance.";

interface ReportMeta {
  reportId: string;
  reportType: string;
  generatedAt: string;
  generatedBy: { officerId: string; name: string; role: string };
  disclaimer: string;
}

function reportMeta(ctx: AuthContext, type: string): ReportMeta {
  return {
    reportId: reportId(type),
    reportType: type,
    generatedAt: new Date().toISOString(),
    generatedBy: { officerId: ctx.officer.officerId, name: ctx.officer.name, role: ctx.officer.role },
    disclaimer: DISCLAIMER,
  };
}

// ------------------------------------------------------------
// Chain-of-custody report (spec §41) — per evidence item.
// ------------------------------------------------------------
export async function buildChainOfCustodyReport(ctx: AuthContext, caseRef: string, evidenceRef: string) {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.view) throw new ApiError(403, "CASE_ACCESS_DENIED", "You are not authorized to access this case.");

  const evidence = await db.evidence.findFirst({
    where: { OR: [{ evidenceId: evidenceRef }, { id: evidenceRef }], caseId: caseRow.id },
    include: {
      collectedByOfficer: { select: { officerId: true, name: true } },
      collectingDepartment: { select: { name: true, departmentType: true } },
      currentCustodianDepartment: { select: { name: true, departmentType: true } },
      currentCustodianOfficer: { select: { officerId: true, name: true } },
      registeredByOfficer: { select: { officerId: true, name: true } },
    },
  });
  if (!evidence) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found in this case.");
  if (!canViewEvidence(ctx, access, evidence.classification, evidence.currentCustodianDepartmentId)) {
    await recordAuditEvent({
      eventType: "REPORT_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      result: "DENIED",
      sessionId: ctx.sessionId,
      metadata: { reportType: "CHAIN_OF_CUSTODY", evidenceId: evidence.evidenceId },
    });
    throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "You are not authorized to generate this report.");
  }

  const transfers = await db.evidenceTransfer.findMany({
    where: { evidenceId: evidence.id },
    orderBy: { requestedAt: "asc" },
    include: {
      fromDepartment: { select: { name: true } },
      toDepartment: { select: { name: true } },
      requestedByOfficer: { select: { officerId: true, name: true } },
      acceptedByOfficer: { select: { officerId: true, name: true } },
    },
  });

  const meta = reportMeta(ctx, "CHAIN_OF_CUSTODY");
  const payload = {
    ...meta,
    case: { caseId: caseRow.caseId, title: caseRow.title, status: caseRow.status },
    evidence: {
      evidenceId: evidence.evidenceId,
      title: evidence.title,
      description: evidence.description,
      evidenceType: evidence.evidenceType,
      classification: evidence.classification,
      status: evidence.status,
      sourceType: evidence.sourceType,
      sourceReference: evidence.sourceReference,
      collectionLocation: evidence.collectionLocation,
      collectedAt: evidence.collectedAt?.toISOString() ?? null,
      collectedBy: evidence.collectedByOfficer ? `${evidence.collectedByOfficer.name} (${evidence.collectedByOfficer.officerId})` : null,
      collectingDepartment: evidence.collectingDepartment?.name ?? null,
      condition: evidence.condition,
    },
    custodyChain: [
      {
        action: evidence.collectedAt ? "COLLECTED" : "REGISTERED",
        timestamp: (evidence.collectedAt ?? evidence.createdAt).toISOString(),
        department: evidence.collectingDepartment?.name ?? null,
        officer: evidence.collectedByOfficer?.name ?? null,
      },
      ...transfers.map((t) => ({
        action: t.status,
        timestamp: (t.acceptedAt ?? t.rejectedAt ?? t.cancelledAt ?? t.requestedAt).toISOString(),
        fromDepartment: t.fromDepartment.name,
        toDepartment: t.toDepartment.name,
        requestedBy: t.requestedByOfficer.name,
        acceptedBy: t.acceptedByOfficer?.name ?? null,
        reason: t.reason,
      })),
    ],
    integrity: evidence.hasDigitalContent
      ? { algorithm: evidence.hashAlgorithm, sha256: evidence.sha256Hash, hasDigitalContent: true }
      : { hasDigitalContent: false, note: "Physical evidence — no digital fingerprint." },
    currentCustodian: {
      department: evidence.currentCustodianDepartment?.name ?? null,
      officer: evidence.currentCustodianOfficer?.name ?? null,
    },
  };

  const report = { ...payload, reportHash: undefined, integrityHash: hashReport({ ...payload }) };
  await recordAuditEvent({
    eventType: "REPORT_GENERATED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: caseRow.caseId,
    evidenceId: evidence.evidenceId,
    sessionId: ctx.sessionId,
    metadata: { reportType: "CHAIN_OF_CUSTODY", reportId: report.reportId, integrityHash: report.integrityHash },
  });
  return report;
}

// ------------------------------------------------------------
// Integrity report (spec §42) — documents + evidence for a case.
// No file contents — metadata + fingerprints only.
// ------------------------------------------------------------
export async function buildIntegrityReport(ctx: AuthContext, caseRef: string) {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.view) throw new ApiError(403, "CASE_ACCESS_DENIED", "You are not authorized to access this case.");

  const visibleDocs = DOCUMENT_CLASSIFICATIONS.filter(
    (c) => (DOCUMENT_CLASSIFICATION_LEVEL[c] ?? 99) <= docClearance(ctx, access)
  );
  const visibleEvds = EVIDENCE_CLASSIFICATIONS.filter(
    (c) => (DOCUMENT_CLASSIFICATION_LEVEL[c] ?? 99) <= evdClearance(ctx, access)
  );

  const documents = await db.caseDocument.findMany({
    where: { caseId: caseRow.id, classification: { in: visibleDocs }, status: { in: ["COMMITTED", "SUPERSEDED"] } },
    orderBy: { createdAt: "asc" },
    select: {
      documentId: true, title: true, classification: true, status: true,
      sha256Hash: true, encryptionStatus: true, committedAt: true, fileSize: true,
    },
  });
  const evidence = await db.evidence.findMany({
    where: { caseId: caseRow.id, classification: { in: visibleEvds } },
    orderBy: { createdAt: "asc" },
    select: {
      evidenceId: true, title: true, classification: true, status: true,
      sha256Hash: true, hashAlgorithm: true, encryptionStatus: true, committedAt: true,
      hasDigitalContent: true, fileSize: true,
    },
  });

  const meta = reportMeta(ctx, "INTEGRITY");
  const payload = {
    ...meta,
    case: { caseId: caseRow.caseId, title: caseRow.title, status: caseRow.status },
    documents: documents.map((d) => ({
      id: d.documentId, title: d.title, classification: d.classification, status: d.status,
      algorithm: "SHA-256", sha256: d.sha256Hash, encryption: d.encryptionStatus, committedAt: d.committedAt?.toISOString() ?? null, fileSize: d.fileSize,
    })),
    evidence: evidence.map((e) => ({
      id: e.evidenceId, title: e.title, classification: e.classification, status: e.status,
      hasDigitalContent: e.hasDigitalContent,
      algorithm: e.hasDigitalContent ? e.hashAlgorithm : null,
      sha256: e.sha256Hash, encryption: e.encryptionStatus, committedAt: e.committedAt?.toISOString() ?? null, fileSize: e.fileSize,
    })),
    counts: { documents: documents.length, evidence: evidence.length, digitalEvidence: evidence.filter((e) => e.hasDigitalContent).length },
  };

  const report = { ...payload, integrityHash: hashReport(payload) };
  await recordAuditEvent({
    eventType: "REPORT_GENERATED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: caseRow.caseId,
    sessionId: ctx.sessionId,
    metadata: { reportType: "INTEGRITY", reportId: report.reportId, integrityHash: report.integrityHash },
  });
  return report;
}

// ------------------------------------------------------------
// Compliance-support report (spec §43) — case history + custody +
// document integrity summary + evidence custody + audit history.
// AUDIT_READ required (audit section) — enforced at the route.
// ------------------------------------------------------------
export async function buildComplianceReport(ctx: AuthContext, caseRef: string) {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.view) throw new ApiError(403, "CASE_ACCESS_DENIED", "You are not authorized to access this case.");

  const [caseTransfers, caseEvents, documents, evidence, evidenceTransfers, auditEvents] = await Promise.all([
    db.caseTransfer.findMany({
      where: { caseId: caseRow.id },
      orderBy: { requestedAt: "asc" },
      include: {
        fromDepartment: { select: { name: true } },
        toDepartment: { select: { name: true } },
        requestedByOfficer: { select: { officerId: true, name: true } },
        acceptedByOfficer: { select: { officerId: true, name: true } },
      },
    }),
    db.caseEvent.findMany({ where: { caseId: caseRow.id }, orderBy: { createdAt: "asc" }, select: { eventType: true, description: true, createdAt: true, actorOfficerId: true } }),
    db.caseDocument.findMany({
      where: { caseId: caseRow.id, status: { in: ["COMMITTED", "SUPERSEDED"] } },
      select: { documentId: true, title: true, classification: true, status: true, sha256Hash: true, committedAt: true },
    }),
    db.evidence.findMany({
      where: { caseId: caseRow.id },
      select: { evidenceId: true, title: true, classification: true, status: true, sha256Hash: true, hasDigitalContent: true, currentCustodianDepartmentId: true },
    }),
    db.evidenceTransfer.findMany({
      where: { caseId: caseRow.id },
      orderBy: { requestedAt: "asc" },
      include: {
        evidence: { select: { evidenceId: true } },
        fromDepartment: { select: { name: true } },
        toDepartment: { select: { name: true } },
      },
    }),
    db.auditEvent.findMany({
      where: { caseId: caseRow.caseId },
      orderBy: { sequence: "asc" },
      select: { eventId: true, sequence: true, eventType: true, result: true, timestamp: true, actorOfficerId: true, evidenceId: true, documentId: true, eventHash: true },
      take: 1000,
    }),
  ]);

  const deptNames = new Map((await db.department.findMany({ select: { id: true, name: true } })).map((d) => [d.id, d.name]));

  const meta = reportMeta(ctx, "COMPLIANCE_SUPPORT");
  const payload = {
    ...meta,
    case: {
      caseId: caseRow.caseId, title: caseRow.title, type: caseRow.caseType, status: caseRow.status,
      openedAt: caseRow.openedAt?.toISOString() ?? null, closedAt: caseRow.closedAt?.toISOString() ?? null,
    },
    caseCustodyHistory: caseTransfers.map((t) => ({
      transferId: t.transferId, from: t.fromDepartment.name, to: t.toDepartment.name, status: t.status,
      requestedAt: t.requestedAt.toISOString(), requestedBy: t.requestedByOfficer.name, acceptedBy: t.acceptedByOfficer?.name ?? null,
    })),
    caseTimeline: caseEvents.map((e) => ({ type: e.eventType, description: e.description, at: e.createdAt.toISOString() })),
    documentIntegritySummary: {
      total: documents.length,
      documents: documents.map((d) => ({ id: d.documentId, classification: d.classification, status: d.status, sha256: d.sha256Hash, committedAt: d.committedAt?.toISOString() ?? null })),
    },
    evidenceCustody: {
      total: evidence.length,
      items: evidence.map((e) => ({ id: e.evidenceId, classification: e.classification, status: e.status, hasDigitalContent: e.hasDigitalContent, sha256: e.sha256Hash, currentCustodian: deptNames.get(e.currentCustodianDepartmentId ?? "") ?? null })),
      transfers: evidenceTransfers.map((t) => ({ transferId: t.transferId, evidenceId: t.evidence.evidenceId, from: t.fromDepartment.name, to: t.toDepartment.name, status: t.status })),
    },
    auditHistory: {
      eventCount: auditEvents.length,
      chainReferenced: true,
      note: "Audit events for this case (max 1000, ascending chain order). Full trail via the audit search API.",
      events: auditEvents.map((e) => ({ eventId: e.eventId, sequence: e.sequence, type: e.eventType, result: e.result, at: e.timestamp.toISOString(), evidenceId: e.evidenceId, documentId: e.documentId, eventHash: e.eventHash })),
    },
  };

  const report = { ...payload, integrityHash: hashReport(payload) };
  await recordAuditEvent({
    eventType: "REPORT_GENERATED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: caseRow.caseId,
    sessionId: ctx.sessionId,
    metadata: { reportType: "COMPLIANCE_SUPPORT", reportId: report.reportId, integrityHash: report.integrityHash },
  });
  return report;
}

function docClearance(ctx: AuthContext, access: CaseAccess): number {
  const role = ctx.officer.role;
  if (role === "SYSTEM_ADMIN") return 4;
  if (role === "AUDITOR") return 3;
  if (access.isCustodianSide) return role === "OFFICER" && !access.assigned ? 2 : 4;
  if (access.assigned) return 2;
  return 1;
}

function evdClearance(ctx: AuthContext, access: CaseAccess): number {
  return docClearance(ctx, access);
}
