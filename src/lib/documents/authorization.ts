import type { AuthContext } from "@/lib/auth";
import type { CaseAccess } from "@/lib/cases/access";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import {
  DOCUMENT_CLASSIFICATION_LEVEL,
  DOCUMENT_CLASSIFICATION_CEILING,
  DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES,
} from "@/lib/constants";

// ============================================================
// DocumentAuthorizationService (spec §24/§25/§34/§55).
//
// CASE authorization is necessary; DOCUMENT classification then
// further restricts. "Can see the case" never implies "can see
// every document" (spec §24).
//
// Clearance model (view/download):
//   SYSTEM_ADMIN .............. all classifications
//   AUDITOR ................... up to RESTRICTED (audit visibility)
//   Custodian-side admin ...... all classifications
//   Custodian-side assigned officer all classifications
//   Custodian-side unassigned officer up to CONFIDENTIAL
//   Other case participants ... up to CONFIDENTIAL
//     (assigned non-custodian)  up to CONFIDENTIAL
//     (unassigned participant)  up to INTERNAL
//   Pending-transfer viewer ... up to INTERNAL
//
// Upload / related-document creation (spec §25/§26/§55): requires
// case-level MANAGE (which only custodian-side actors and the
// system admin hold) + DOCUMENT_UPLOAD permission + a case status
// that accepts additions + classification within the role ceiling.
// Historical departments keep READ access — never write authority
// — after a custody transfer (spec §25/§55).
//
// canModifyMetadata: COMMITTED documents are immutable (spec §35/
// §36); the answer is always false and no metadata-edit API exists.
// ============================================================

/** Highest classification level the viewer may see on this case. */
export function documentViewClearance(ctx: AuthContext, access: CaseAccess): number {
  const role = ctx.officer.role;
  if (role === "SYSTEM_ADMIN") return 4; // HIGHLY_RESTRICTED
  if (role === "AUDITOR") return 3; // RESTRICTED — audit visibility stops short of HIGHLY_RESTRICTED
  if (access.isCustodianSide) {
    if (role === "DEPARTMENT_ADMIN") return 4;
    if (role === "OFFICER" && access.assigned) return 4;
    return 2; // unassigned custodian-department officers: CONFIDENTIAL
  }
  if (access.assigned) return 2; // assigned participants keep CONFIDENTIAL visibility
  return 1; // participants / pending-transfer viewers: INTERNAL
}

export function canViewDocument(ctx: AuthContext, access: CaseAccess, classification: string, status: string): boolean {
  if (!access.view) return false;
  // Quarantined records are a security state: system-administrative visibility only.
  if (status === "QUARANTINED" && ctx.officer.role !== "SYSTEM_ADMIN") return false;
  const level = DOCUMENT_CLASSIFICATION_LEVEL[classification] ?? 99;
  if (level === 99) return ctx.officer.role === "SYSTEM_ADMIN"; // unknown classification: deny except admin
  return level <= documentViewClearance(ctx, access);
}

export function canDownloadDocument(ctx: AuthContext, access: CaseAccess, classification: string, status: string): boolean {
  // Download is view-equivalent in Phase 3; the AUDITOR permission set
  // deliberately includes only DOCUMENT_READ (no mutation surface).
  if (!roleHas(ctx.officer.role, PERMISSIONS.DOCUMENT_READ)) return false;
  return canViewDocument(ctx, access, classification, status);
}

/** Highest classification the actor may ASSIGN on uploads to this case. */
export function documentUploadCeiling(ctx: AuthContext): number {
  return DOCUMENT_CLASSIFICATION_CEILING[ctx.officer.role] ?? -1;
}

export function canUploadToCase(
  ctx: AuthContext,
  access: CaseAccess,
  caseStatus: string,
  requestedClassification: string
): { allowed: boolean; reason?: string } {
  if (!roleHas(ctx.officer.role, PERMISSIONS.DOCUMENT_UPLOAD)) {
    return { allowed: false, reason: "Your role is not authorized to upload documents." };
  }
  if (!access.manage) {
    return { allowed: false, reason: "Only the current custodian can add documents to this case." };
  }
  if (!DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES.includes(caseStatus)) {
    return { allowed: false, reason: `Case status ${caseStatus} does not accept new documents.` };
  }
  const level = DOCUMENT_CLASSIFICATION_LEVEL[requestedClassification];
  if (level === undefined) return { allowed: false, reason: "Unknown security classification." };
  if (level > documentUploadCeiling(ctx)) {
    return { allowed: false, reason: "Your role cannot assign this security classification." };
  }
  return { allowed: true };
}

/** Supplement/correction/replacement and relationship creation share upload authority. */
export function canCreateRelated(
  ctx: AuthContext,
  access: CaseAccess,
  caseStatus: string,
  requestedClassification: string
): { allowed: boolean; reason?: string } {
  return canUploadToCase(ctx, access, caseStatus, requestedClassification);
}

/**
 * Committed documents are immutable (spec §34/§35/§36). Phase 3
 * exposes no metadata-edit API; this predicate documents the policy
 * and stays for future pre-commit flows.
 */
export function canModifyMetadata(_ctx: AuthContext, _status: string): boolean {
  return false;
}
