import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { assertCaseView, type CaseAccess } from "@/lib/cases/access";
import { canViewEvidence } from "@/lib/evidence/authorization";
import { recordAuditEvent } from "@/lib/audit/service";

// ============================================================
// Route-level evidence loading & authorization guards.
//
// 404 when the evidence does not exist OR does not belong to the
// case in the URL (wrong case/evidence combination — existence is
// never leaked across case boundaries). Denied views produce an
// EVIDENCE_ACCESS_DENIED audit event (spec §21/§47) without
// disclosing classification details (spec §47: no resource
// existence disclosure to unauthorized callers).
// ============================================================

export interface LoadedEvidence {
  caseRow: { id: string; caseId: string; status: string };
  access: CaseAccess;
  evidence: {
    id: string;
    evidenceId: string;
    title: string;
    status: string;
    classification: string;
    hasDigitalContent: boolean;
    storageKey: string | null;
    mimeType: string | null;
    originalFilename: string | null;
    fileSize: number | null;
    sha256Hash: string | null;
    hashAlgorithm: string;
    currentCustodianDepartmentId: string | null;
    version: number;
  };
}

const EVIDENCE_SELECT = {
  id: true,
  evidenceId: true,
  caseId: true,
  title: true,
  status: true,
  classification: true,
  hasDigitalContent: true,
  storageKey: true,
  mimeType: true,
  originalFilename: true,
  fileSize: true,
  sha256Hash: true,
  hashAlgorithm: true,
  currentCustodianDepartmentId: true,
  version: true,
} as const;

export async function loadEvidenceForView(
  ctx: AuthContext,
  caseRef: string,
  evidenceRef: string
): Promise<LoadedEvidence> {
  const { caseRow, access } = await assertCaseView(ctx, caseRef);

  const evidence = await db.evidence.findFirst({
    where: { OR: [{ evidenceId: evidenceRef }, { id: evidenceRef }], caseId: caseRow.id },
    select: EVIDENCE_SELECT,
  });
  if (!evidence) {
    throw new ApiError(404, ERROR_CODES.EVIDENCE_NOT_FOUND, "Evidence not found in this case.");
  }
  return { caseRow, access, evidence: evidence as LoadedEvidence["evidence"] };
}

export async function assertEvidenceViewable(
  ctx: AuthContext,
  caseRef: string,
  evidenceRef: string,
  action: "view" | "download" | "verify" | "details"
): Promise<LoadedEvidence> {
  const loaded = await loadEvidenceForView(ctx, caseRef, evidenceRef);
  const { caseRow, evidence, access } = loaded;
  if (!canViewEvidence(ctx, access, evidence.classification, evidence.currentCustodianDepartmentId)) {
    // §47: every sensitive unauthorized attempt is audited. The error
    // is a generic denial — no classification/eligibility detail.
    await recordAuditEvent({
      eventType: "EVIDENCE_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      actorIdentifier: ctx.officer.officerId,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      evidenceId: evidence.evidenceId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { evidenceId: evidence.evidenceId, action },
    });
    throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, "You are not authorized to access this evidence.");
  }
  return loaded;
}
