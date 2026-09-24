import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";
import type { AuthContext } from "@/lib/auth";
import { roleHas, PERMISSIONS } from "@/lib/permissions";

// ============================================================
// Case-level authorization (spec §14/§45/§46/§50).
//
// An officer does NOT automatically gain access to every case of
// their department. Access is derived from ALL of:
//   1. Current custodian (department-level operational control)
//   2. Case department participation (historical read for depts)
//   3. Explicit case assignment (CaseOfficer rows)
//   4. System-level role authorization
//
// Role permission (case.*) is necessary but never sufficient —
// every case API additionally evaluates the case-level result
// here. NOTHING is trusted from the client.
// ============================================================

export type CaseAccessLevel = "none" | "view" | "manage";

export interface CaseAccess {
  level: CaseAccessLevel;
  view: boolean;
  manage: boolean;
  /** Whether the actor's department is the current custodian. */
  isCustodianSide: boolean;
  /** Whether the actor belongs to the originating department. */
  isOriginSide: boolean;
  /** Whether the actor has an explicit ACTIVE case-officer assignment. */
  assigned: boolean;
  /** Human-readable explanation (used by GET /cases/{id}/access). */
  reasons: string[];
}

interface CaseAccessRow {
  id: string;
  status: string;
  originatingDepartmentId: string;
  currentCustodianDepartmentId: string;
}

interface CaseAccessOptions {
  /** Destination department for transfer decisions (accept/reject). */
  destinationDepartmentId?: string | null;
}

export async function loadCaseForAccess(caseRef: string) {
  // caseRef may be the public Case ID (CASE-…) or internal id — both are
  // looked up server-side; public ID is the canonical client reference.
  return db.case.findFirst({
    where: { OR: [{ caseId: caseRef }, { id: caseRef }] },
    include: {
      departments: true,
      officers: { where: { status: "ACTIVE" } },
      transfers: { where: { status: "REQUESTED" }, select: { toDepartmentId: true } },
    },
  });
}

export function computeCaseAccess(
  ctx: AuthContext,
  caseRow: CaseAccessRow & {
    departments: { departmentId: string; status: string; participationType: string }[];
    officers: { officerId: string; status: string }[];
    transfers?: { toDepartmentId: string }[];
  },
  opts: CaseAccessOptions = {}
): CaseAccess {
  const reasons: string[] = [];
  const role = ctx.officer.role;
  const myDept = ctx.officer.departmentId;
  const myOfficerId = ctx.officer.id;

  const isCustodianSide = caseRow.currentCustodianDepartmentId === myDept;
  const isOriginSide = caseRow.originatingDepartmentId === myDept;
  const participation = caseRow.departments.find(
    (d) => d.departmentId === myDept && d.status === "ACTIVE"
  );
  const assignment = caseRow.officers.find((o) => o.officerId === myOfficerId && o.status === "ACTIVE");
  if (assignment) reasons.push("You are explicitly assigned to this case.");
  if (isCustodianSide) reasons.push("Your department is the current custodian of this case.");
  if (isOriginSide && !isCustodianSide) reasons.push("Your department originated this case.");
  if (participation && !isCustodianSide) {
    reasons.push(`Your department is a ${participation.participationType.replace("_", " ").toLowerCase()} participant.`);
  }

  let level: CaseAccessLevel = "none";

  if (role === "SYSTEM_ADMIN") {
    level = "manage";
    reasons.push("Platform administrator authority.");
  } else if (role === "AUDITOR") {
    // Read-only global visibility per audit policy; write is never granted.
    level = "view";
    reasons.push("Auditor read-only visibility.");
  } else if (role === "DEPARTMENT_ADMIN") {
    if (isCustodianSide) {
      level = "manage";
      reasons.push("Department administrators of the current custodian manage the case.");
    } else if (participation) {
      level = "view";
      reasons.push("Department administrators of participating departments retain read access.");
    }
  } else if (role === "OFFICER") {
    if (isCustodianSide && assignment) {
      level = "manage";
      reasons.push("Assigned officers of the current custodian manage the case.");
    } else if (isCustodianSide) {
      level = "view";
      reasons.push("Officers of the current custodian department can view the case.");
    } else if (assignment) {
      level = "view";
      reasons.push("Explicitly assigned officers retain case visibility.");
    }
  }

  // Destination-side review (spec §21): the receiving department of a
  // pending transfer can view the case to decide, before participation.
  const incoming = caseRow.transfers?.some((t) => t.toDepartmentId === myDept);
  if (incoming && level === "none") {
    level = "view";
    reasons.push("Your department has a pending incoming custody transfer for this case.");
  }

  const access: CaseAccess = {
    level,
    view: level !== "none",
    manage: level === "manage",
    isCustodianSide,
    isOriginSide,
    assigned: !!assignment,
    reasons,
  };

  // Transfer decision rights (destination side) are computed separately —
  // the destination department is typically NOT yet a participant.
  void opts.destinationDepartmentId;
  return access;
}

export async function resolveCaseAccess(
  ctx: AuthContext,
  caseRef: string,
  opts: CaseAccessOptions = {}
): Promise<{ caseRow: NonNullable<Awaited<ReturnType<typeof loadCaseForAccess>>>; access: CaseAccess }> {
  const caseRow = await loadCaseForAccess(caseRef);
  if (!caseRow) throw new ApiError(404, ERROR_CODES.CASE_NOT_FOUND, "Case not found.");
  const access = computeCaseAccess(ctx, caseRow, opts);
  return { caseRow, access };
}

export async function assertCaseView(ctx: AuthContext, caseRef: string) {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.view) {
    throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
  }
  return { caseRow, access };
}

export async function assertCaseManage(ctx: AuthContext, caseRef: string) {
  const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
  if (!access.manage) {
    throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to manage this case.");
  }
  return { caseRow, access };
}

/** Requires role permission AND case-level manage rights. */
export async function assertCaseManageWithPermission(
  ctx: AuthContext,
  caseRef: string,
  permission: Permission
) {
  if (!roleHas(ctx.officer.role, permission)) {
    throw new ApiError(403, ERROR_CODES.FORBIDDEN, "You are not authorized to perform this action.");
  }
  return assertCaseManage(ctx, caseRef);
}

type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
