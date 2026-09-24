import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { recordAuditEvent } from "@/lib/audit/service";
import { requirePermission } from "@/lib/auth";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import { computeCaseAccess, type CaseAccess } from "@/lib/cases/access";
import { documentViewClearance } from "@/lib/documents/authorization";
import { DOCUMENT_CLASSIFICATION_LEVEL } from "@/lib/constants";
import { getAIConfig } from "./config";

// ============================================================
// AI authorization boundary (spec §22/§26/§34).
//
// THE CRITICAL RULE: authorization is resolved BEFORE retrieval.
// USER → AUTHORIZATION CONTEXT → AUTHORIZED SCOPE → SEARCH →
// AUTHORIZED RESULTS. There is no code path that searches first
// and filters afterwards.
//
// buildAuthorizedScope() enumerates every case the caller may view
// (server-side computeCaseAccess) and pairs each case with the
// DOCUMENT clearance level derived from the same model the document
// APIs use (documentViewClearance). Every AI retrieval (search,
// QA, case summary, related-document suggestions) funnels through
// this scope. Document-level clearance is re-checked again inside
// the vector search itself (defense in depth).
// ============================================================

export interface AuthorizedCaseScope {
  caseRef: string; // public CASE id
  caseInternalId: string;
  clearance: number; // DOCUMENT_CLASSIFICATION_LEVEL scale
  access: CaseAccess;
}

export async function buildAuthorizedScope(ctx: AuthContext): Promise<Map<string, AuthorizedCaseScope>> {
  const cases = await db.case.findMany({
    select: {
      id: true,
      caseId: true,
      status: true,
      originatingDepartmentId: true,
      currentCustodianDepartmentId: true,
      departments: { select: { departmentId: true, status: true, participationType: true } },
      officers: { where: { status: "ACTIVE" }, select: { officerId: true, status: true } },
      transfers: { where: { status: "REQUESTED" }, select: { toDepartmentId: true } },
    },
  });
  const scope = new Map<string, AuthorizedCaseScope>();
  for (const row of cases) {
    const access = computeCaseAccess(ctx, row);
    if (!access.view) continue;
    const clearance = documentViewClearance(ctx, access);
    scope.set(row.caseId, {
      caseRef: row.caseId,
      caseInternalId: row.id,
      clearance,
      access,
    });
  }
  return scope;
}

/** Require AI use permission + AI enabled + return scope. Audits denial. */
export async function requireAIAccess(req: Request): Promise<{ ctx: AuthContext; config: Awaited<ReturnType<typeof getAIConfig>> }> {
  let ctx: AuthContext;
  try {
    ctx = await requirePermission(req, PERMISSIONS.AI_USE);
  } catch (err) {
    await recordAuditEvent({
      eventType: "AI_ACCESS_DENIED",
      result: "DENIED",
      sessionId: undefined,
      metadata: { reason: "permission" },
    }).catch(() => undefined);
    throw err;
  }
  const config = await getAIConfig();
  if (!config.aiEnabled) {
    await recordAuditEvent({
      eventType: "AI_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { reason: "ai_disabled" },
    }).catch(() => undefined);
    throw new ApiError(503, "AI_DISABLED", "AI services are currently disabled by the platform administrator.");
  }
  return { ctx, config };
}

/** Case-scoped AI access: view permission on the case + AI use. Audits denial. */
export async function requireCaseAIAccess(
  req: Request,
  caseRef: string
): Promise<{ ctx: AuthContext; caseRow: NonNullable<Awaited<ReturnType<typeof loadCase>>>; access: CaseAccess; config: Awaited<ReturnType<typeof getAIConfig>> }> {
  const { ctx, config } = await requireAIAccess(req);
  const caseRow = await loadCase(caseRef);
  if (!caseRow) throw new ApiError(404, "CASE_NOT_FOUND", "Case not found.");
  const access = computeCaseAccess(ctx, caseRow);
  if (!access.view) {
    await recordAuditEvent({
      eventType: "AI_ACCESS_DENIED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      sessionId: ctx.sessionId,
      result: "DENIED",
      metadata: { reason: "case_access" },
    }).catch(() => undefined);
    throw new ApiError(403, "AI_ACCESS_DENIED", "You are not authorized to use AI services on this case.");
  }
  return { ctx, caseRow, access, config };
}

function loadCase(caseRef: string) {
  return db.case.findFirst({
    where: { OR: [{ caseId: caseRef }, { id: caseRef }] },
    include: {
      departments: true,
      officers: { where: { status: "ACTIVE" } },
      transfers: { where: { status: "REQUESTED" }, select: { toDepartmentId: true } },
    },
  });
}

/** Verify the caller may view a specific document (case access + clearance + status). Audits denial. */
export async function assertDocumentAIAccess(
  ctx: AuthContext,
  caseRow: { id: string; caseId: string },
  document: { id: string; documentId: string; classification: string; status: string },
  access: CaseAccess
): Promise<void> {
  if (document.status === "QUARANTINED" && ctx.officer.role !== "SYSTEM_ADMIN") {
    await auditDocDenial(ctx, caseRow, document, "quarantined");
    throw new ApiError(403, "AI_ACCESS_DENIED", "You are not authorized to use AI services on this document.");
  }
  const level = DOCUMENT_CLASSIFICATION_LEVEL[document.classification] ?? 99;
  const clearance = documentViewClearance(ctx, access);
  if (level === 99 || level > clearance) {
    await auditDocDenial(ctx, caseRow, document, "classification");
    throw new ApiError(403, "AI_ACCESS_DENIED", "Your clearance does not permit AI processing of this document's classification.");
  }
}

async function auditDocDenial(
  ctx: AuthContext,
  caseRow: { id: string; caseId: string },
  document: { documentId: string },
  reason: string
): Promise<void> {
  await recordAuditEvent({
    eventType: "AI_ACCESS_DENIED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: caseRow.caseId,
    documentId: document.documentId,
    sessionId: ctx.sessionId,
    result: "DENIED",
    metadata: { reason },
  }).catch(() => undefined);
}

export function roleCanReview(ctx: AuthContext): boolean {
  return roleHas(ctx.officer.role, PERMISSIONS.AI_REVIEW);
}

/** Load documents of a case, clearance-filtered IN-QUERY (same model as the document list API). */
export async function authorizedCaseDocuments(ctx: AuthContext, caseInternalId: string, clearance: number) {
  const docs = await db.caseDocument.findMany({
    where: { caseId: caseInternalId, status: { in: ["COMMITTED", "SUPERSEDED"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      documentId: true,
      title: true,
      documentType: true,
      classification: true,
      status: true,
      sha256Hash: true,
      committedAt: true,
    },
  });
  return docs.filter((d) => (DOCUMENT_CLASSIFICATION_LEVEL[d.classification] ?? 99) <= clearance);
}
