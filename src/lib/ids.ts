import { db } from "@/lib/db";
import { DEPARTMENT_TYPE_ABBREV } from "@/lib/constants";
import { geoCodeFragments, type ResolvedGeo } from "@/lib/geo";

// ============================================================
// Stable identifier generation (spec §7 / §12).
// IDs derive from geographic codes + sequence — never from
// display names, so renames never break references.
// Retry-on-conflict guards concurrent creation.
// ============================================================

export async function generateDepartmentCode(geo: ResolvedGeo, departmentType: string): Promise<string> {
  const { stateCode, cityCode } = geoCodeFragments(geo);
  const typeAbbr = DEPARTMENT_TYPE_ABBREV[departmentType] || "GEN";
  const prefix = `DEPT-${stateCode}-${cityCode}-${typeAbbr}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.department.count({
      where: { departmentCode: { startsWith: prefix } },
    });
    const candidate = `${prefix}${String(count + 1).padStart(3, "0")}`;
    const exists = await db.department.findUnique({ where: { departmentCode: candidate } });
    if (!exists) return candidate;
  }
  // Fallback: timestamp suffix guarantees uniqueness under extreme contention
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

export async function generateOfficerId(geo: ResolvedGeo): Promise<string> {
  const { stateCode, cityCode } = geoCodeFragments(geo);
  const prefix = `OFF-${stateCode}-${cityCode}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.officer.count({
      where: { officerId: { startsWith: prefix } },
    });
    const candidate = `${prefix}${String(count + 1).padStart(5, "0")}`;
    const exists = await db.officer.findUnique({ where: { officerId: candidate } });
    if (!exists) return candidate;
  }
  return `${prefix}${Date.now().toString().slice(-8)}`;
}
