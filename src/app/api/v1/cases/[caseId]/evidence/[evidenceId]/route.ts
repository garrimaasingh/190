import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loadEvidenceForView } from "@/lib/evidence/workflows";
import { canViewEvidence } from "@/lib/evidence/authorization";
import { toEvidenceSummary } from "@/lib/evidence/service";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit/service";
import type { EvidenceSummaryRow } from "@/lib/evidence/service";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/evidence/{evidenceId} — evidence details
// (spec §63). storageKey/keyReference/internal ids NEVER appear in
// responses (spec §5). Viewing details is audited (EVIDENCE_VIEWED)
// — access enforcement never depends on the audit write succeeding.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId, evidenceId } = await params;
    const { caseRow, evidence, access } = await loadEvidenceForView(ctx, caseId, evidenceId);

    if (!canViewEvidence(ctx, access, evidence.classification, evidence.currentCustodianDepartmentId)) {
      await recordAuditEvent({
        eventType: "EVIDENCE_ACCESS_DENIED",
        actorOfficerId: ctx.officer.id,
        actorIdentifier: ctx.officer.officerId,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        result: "DENIED",
        metadata: { evidenceId: evidence.evidenceId, action: "details" },
      });
      throw new ApiError(403, "EVIDENCE_ACCESS_DENIED", "You are not authorized to access this evidence.");
    }

    const full = await db.evidence.findUnique({
      where: { id: evidence.id },
      include: {
        registeredByOfficer: { select: { officerId: true, name: true } },
        currentCustodianDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
        currentCustodianOfficer: { select: { officerId: true, name: true } },
        collectedByOfficer: { select: { officerId: true, name: true } },
        collectingDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
      },
    });
    if (!full) {
      throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");
    }

    // Relationships (documents describing this evidence).
    const relationships = await db.evidenceDocumentRelationship.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        relationshipType: true,
        note: true,
        createdAt: true,
        document: { select: { documentId: true, title: true, documentType: true, classification: true, status: true } },
        createdByOfficer: { select: { officerId: true, name: true } },
      },
    });

    await recordAuditEvent({
      eventType: "EVIDENCE_VIEWED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      evidenceId: evidence.evidenceId,
      sessionId: ctx.sessionId,
      metadata: { evidenceId: evidence.evidenceId, action: "details" },
    });

    const { id: _id, caseId: _c, registeredByDepartmentId: _r, currentCustodianDepartmentId: _cur, ...rest } = full as EvidenceSummaryRow & { id: string };
    void _id;
    void _c;
    void _r;
    void _cur;

    return jsonOk({
      evidence: toEvidenceSummary(full as unknown as EvidenceSummaryRow, caseRow.caseId),
      relationships,
      custodianIsMe: ctx.officer.departmentId === evidence.currentCustodianDepartmentId,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
