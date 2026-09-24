import type { AuthContext } from "@/lib/auth";
import type { CaseAccess } from "@/lib/cases/access";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import {
  DOCUMENT_CLASSIFICATION_LEVEL,
  DOCUMENT_CLASSIFICATION_CEILING,
  DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES,
} from "@/lib/constants";

// ============================================================
// EvidenceAuthorizationService (spec §19).
//
// Case access is NECESSARY but never sufficient (spec §19): the
// evidence classification further restricts, exactly like Phase 3
// documents. "Can view the case" does NOT imply "can view every
// evidence item" — a HIGHLY_RESTRICTED item is denied to a viewer
// whose clearance stops lower.
//
// Clearance model (view/download) — mirrors the Phase 3 document
// model per spec §9 ("follow existing Phase 3 terminology"):
//   SYSTEM_ADMIN .............. all classifications
//   AUDITOR ................... up to RESTRICTED (read-only)
//   Custodian-side admin ...... all classifications
//   Custodian-side assigned officer all classifications
//   Custodian-side unassigned officer up to CONFIDENTIAL
//   Assigned participant ...... up to CONFIDENTIAL
//   Other case participants ... up to INTERNAL
//   Pending-transfer viewer ... up to INTERNAL
//
// WRITE authority (register/status/relationships/transfer initiate):
// custodian-side actors with EVIDENCE_MANAGE + a live case status;
// transfer DECIDE belongs to the receiving department (or the
// platform administrator). AUDITORS NEVER WRITE (spec §34).
//
// Integrity fields (sha256Hash/hashAlgorithm/storageKey/
// storageProvider) are IMMUTABLE after commit (spec §13): no
// predicate here allows modifying them, no API accepts them.
// ============================================================

/**
 * Highest classification level the viewer may see on this case.
 *
 * EVIDENCE-CUSTODIAN FACTOR (spec §19): authorization considers the
 * CURRENT EVIDENCE CUSTODIAN independently of the case custodian —
 * after an evidence transfer the receiving department gains
 * custodian-side clearance for that ITEM even though the CASE
 * custody never moved. This is exactly the §45 distinction.
 */
export function evidenceViewClearance(
  ctx: AuthContext,
  access: CaseAccess,
  evidenceCustodianDepartmentId?: string | null
): number {
  const role = ctx.officer.role;
  if (role === "SYSTEM_ADMIN") return 4; // HIGHLY_RESTRICTED
  if (role === "AUDITOR") return 3; // RESTRICTED — audit visibility stops short of HIGHLY_RESTRICTED
  const isItemCustodian =
    !!evidenceCustodianDepartmentId && evidenceCustodianDepartmentId === ctx.officer.departmentId;
  if (isItemCustodian || access.isCustodianSide) {
    if (role === "DEPARTMENT_ADMIN") return 4;
    if (role === "OFFICER" && (access.assigned || isItemCustodian)) return 4;
    return 2; // unassigned custodian-department officers: CONFIDENTIAL
  }
  if (access.assigned) return 2; // assigned participants keep CONFIDENTIAL visibility
  return 1; // participants / pending-transfer viewers: INTERNAL
}

export function canViewEvidence(
  ctx: AuthContext,
  access: CaseAccess,
  classification: string,
  evidenceCustodianDepartmentId?: string | null
): boolean {
  if (!access.view) return false;
  const level = DOCUMENT_CLASSIFICATION_LEVEL[classification] ?? 99;
  if (level === 99) return ctx.officer.role === "SYSTEM_ADMIN"; // unknown classification: deny except admin
  return level <= evidenceViewClearance(ctx, access, evidenceCustodianDepartmentId);
}

export function canDownloadEvidence(
  ctx: AuthContext,
  access: CaseAccess,
  classification: string,
  evidenceCustodianDepartmentId?: string | null
): boolean {
  // Download is view-equivalent; AUDITOR's permission set includes
  // EVIDENCE_READ (read-only) — no mutation surface exists (spec §34).
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_READ)) return false;
  return canViewEvidence(ctx, access, classification, evidenceCustodianDepartmentId);
}

/** Highest classification the actor may ASSIGN when registering evidence. */
export function evidenceRegisterCeiling(ctx: AuthContext): number {
  return DOCUMENT_CLASSIFICATION_CEILING[ctx.officer.role] ?? -1;
}

export function canRegisterEvidence(
  ctx: AuthContext,
  access: CaseAccess,
  caseStatus: string,
  requestedClassification: string
): { allowed: boolean; reason?: string } {
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_MANAGE)) {
    return { allowed: false, reason: "Your role is not authorized to register evidence." };
  }
  if (!access.manage) {
    return { allowed: false, reason: "Only the current custodian can register evidence on this case." };
  }
  if (!DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES.includes(caseStatus)) {
    return { allowed: false, reason: `Case status ${caseStatus} does not accept new evidence.` };
  }
  const level = DOCUMENT_CLASSIFICATION_LEVEL[requestedClassification];
  if (level === undefined) return { allowed: false, reason: "Unknown security classification." };
  if (level > evidenceRegisterCeiling(ctx)) {
    return { allowed: false, reason: "Your role cannot assign this security classification." };
  }
  return { allowed: true };
}

/** Relationship creation shares registration authority (custodian-side manage). */
export function canCreateEvidenceRelationship(
  ctx: AuthContext,
  access: CaseAccess,
  caseStatus: string
): { allowed: boolean; reason?: string } {
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_MANAGE)) {
    return { allowed: false, reason: "Your role is not authorized to manage evidence relationships." };
  }
  if (!access.manage) {
    return { allowed: false, reason: "Only the current custodian can manage evidence relationships." };
  }
  if (!DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES.includes(caseStatus)) {
    return { allowed: false, reason: `Case status ${caseStatus} does not accept evidence changes.` };
  }
  return { allowed: true };
}

export function canInitiateEvidenceTransfer(ctx: AuthContext, evidenceCustodianDepartmentId: string | null): boolean {
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_TRANSFER_INITIATE)) return false;
  if (ctx.officer.role === "SYSTEM_ADMIN") return true; // platform authority
  return !!evidenceCustodianDepartmentId && evidenceCustodianDepartmentId === ctx.officer.departmentId;
}

export function canDecideEvidenceTransfer(ctx: AuthContext, toDepartmentId: string): boolean {
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_TRANSFER_DECIDE)) return false;
  if (ctx.officer.role === "SYSTEM_ADMIN") return true; // platform authority
  return ctx.officer.departmentId === toDepartmentId;
}

/**
 * Controlled status changes (spec §8): custodian-side manage
 * authority; TRANSFER_PENDING is service-managed and can never be
 * set or cleared through the status endpoint.
 */
export function canChangeEvidenceStatus(ctx: AuthContext, access: CaseAccess, currentStatus: string): { allowed: boolean; reason?: string } {
  if (!roleHas(ctx.officer.role, PERMISSIONS.EVIDENCE_MANAGE)) {
    return { allowed: false, reason: "Your role is not authorized to change evidence status." };
  }
  if (!access.manage) {
    return { allowed: false, reason: "Only the current custodian can change evidence status." };
  }
  if (currentStatus === "TRANSFER_PENDING") {
    return { allowed: false, reason: "Evidence with a pending transfer is managed by the custody service." };
  }
  return { allowed: true };
}

/** Committed evidence is immutable (spec §13) — always false, documents the policy. */
export function canModifyEvidenceIntegrity(_ctx: AuthContext): boolean {
  return false;
}
