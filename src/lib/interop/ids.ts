import { db } from "@/lib/db";

// ============================================================
// Phase 9 — public identity generation for manual interop rows.
// Same fixed-width sequencing discipline as src/lib/ids.ts and
// src/lib/integrations/ids.ts: candidates derive from the MAX
// well-formed numeric suffix already issued — never a row count.
// Package IDs are immutable and NEVER reused (§5).
// ============================================================

async function nextRef(prefix: string, width: number, loadExisting: () => Promise<string[]>, exists: (c: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ids = await loadExisting();
    let max = 0;
    for (const id of ids) {
      const suffix = id.slice(prefix.length);
      if (new RegExp(`^\\d{${width}}$`).test(suffix)) {
        const value = parseInt(suffix, 10);
        if (Number.isFinite(value) && value > max) max = value;
      }
    }
    const candidate = `${prefix}${String(max + 1).padStart(width, "0")}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${prefix}${Date.now().toString().slice(-width)}`;
}

export async function generatePackageId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PKG-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.packageRecord.findMany({ where: { packageId: { startsWith: prefix } }, select: { packageId: true } })).map((r) => r.packageId),
    async (c) => !!(await db.packageRecord.findUnique({ where: { packageId: c } }))
  );
}

export async function generateManualExportJobId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `MEX-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.manualExportJob.findMany({ where: { jobId: { startsWith: prefix } }, select: { jobId: true } })).map((r) => r.jobId),
    async (c) => !!(await db.manualExportJob.findUnique({ where: { jobId: c } }))
  );
}

export async function generateManualImportJobId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `MIM-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.manualImportJob.findMany({ where: { jobId: { startsWith: prefix } }, select: { jobId: true } })).map((r) => r.jobId),
    async (c) => !!(await db.manualImportJob.findUnique({ where: { jobId: c } }))
  );
}

export async function generateManualConflictId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `MCF-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.manualImportConflict.findMany({ where: { conflictId: { startsWith: prefix } }, select: { conflictId: true } })).map((r) => r.conflictId),
    async (c) => !!(await db.manualImportConflict.findUnique({ where: { conflictId: c } }))
  );
}
