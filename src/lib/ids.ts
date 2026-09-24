import { db } from "@/lib/db";
import { DEPARTMENT_TYPE_ABBREV } from "@/lib/constants";
import { geoCodeFragments, type ResolvedGeo } from "@/lib/geo";

// ============================================================
// Stable identifier generation (spec §7 / §12).
// IDs derive from geographic codes + sequence — never from
// display names, so renames never break references.
//
// SEQUENCE CORRECTNESS: candidates derive from the MAX numeric
// suffix already issued for the prefix — never from a row count.
// A count-based sequence breaks as soon as the data has gaps
// (any hard-delete in maintenance/test flows): count+1 can point
// at an existing id, the retry loop re-computes the same dead
// candidate and falls off to the timestamp fallback, producing
// ids that violate the documented fixed-width format.
// The exists() re-check plus retry loop still guards concurrent
// creation; the timestamp fallback remains a last-resort net.
// ============================================================

async function nextSequenceId(
  prefix: string,
  width: number,
  loadExisting: () => Promise<string[]>,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ids = await loadExisting();
    let max = 0;
    for (const id of ids) {
      const suffix = id.slice(prefix.length);
      // Only WELL-FORMED suffixes (exact width) drive the sequence —
      // legacy/timestamp fallback ids must not poison the format.
      if (new RegExp(`^\\d{${width}}$`).test(suffix)) {
        const value = parseInt(suffix, 10);
        if (Number.isFinite(value) && value > max) max = value;
      }
    }
    const candidate = `${prefix}${String(max + 1).padStart(width, "0")}`;
    if (!(await exists(candidate))) return candidate;
  }
  // Last-resort safety net under extreme contention (outside the
  // documented format — retained from the original design).
  return `${prefix}${Date.now().toString().slice(-width)}`;
}

export async function generateDepartmentCode(geo: ResolvedGeo, departmentType: string): Promise<string> {
  const { stateCode, cityCode } = geoCodeFragments(geo);
  const typeAbbr = DEPARTMENT_TYPE_ABBREV[departmentType] || "GEN";
  const prefix = `DEPT-${stateCode}-${cityCode}-${typeAbbr}-`;

  return nextSequenceId(
    prefix,
    3,
    async () =>
      (
        await db.department.findMany({
          where: { departmentCode: { startsWith: prefix } },
          select: { departmentCode: true },
        })
      ).map((r) => r.departmentCode),
    async (candidate) =>
      !!(await db.department.findUnique({ where: { departmentCode: candidate } }))
  );
}

export async function generateOfficerId(geo: ResolvedGeo): Promise<string> {
  const { stateCode, cityCode } = geoCodeFragments(geo);
  const prefix = `OFF-${stateCode}-${cityCode}-`;

  return nextSequenceId(
    prefix,
    5,
    async () =>
      (
        await db.officer.findMany({
          where: { officerId: { startsWith: prefix } },
          select: { officerId: true },
        })
      ).map((r) => r.officerId),
    async (candidate) => !!(await db.officer.findUnique({ where: { officerId: candidate } }))
  );
}
