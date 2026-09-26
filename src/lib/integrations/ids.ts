import { db } from "@/lib/db";

// ============================================================
// Phase 8 — public identity generation for integration rows.
// Same fixed-width sequencing discipline as src/lib/ids.ts:
// candidates derive from the MAX well-formed numeric suffix.
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

export async function generateConnectionId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CONN-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.integrationConnection.findMany({ where: { connectionId: { startsWith: prefix } }, select: { connectionId: true } })).map((r) => r.connectionId),
    async (c) => !!(await db.integrationConnection.findUnique({ where: { connectionId: c } }))
  );
}

export async function generateImportJobId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `IJP-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.integrationImportJob.findMany({ where: { jobId: { startsWith: prefix } }, select: { jobId: true } })).map((r) => r.jobId),
    async (c) => !!(await db.integrationImportJob.findUnique({ where: { jobId: c } }))
  );
}

export async function generateExportJobId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `IEX-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.integrationExportJob.findMany({ where: { jobId: { startsWith: prefix } }, select: { jobId: true } })).map((r) => r.jobId),
    async (c) => !!(await db.integrationExportJob.findUnique({ where: { jobId: c } }))
  );
}

export async function generateConflictId(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `ICF-MP-IND-${year}-`;
  return nextRef(
    prefix,
    6,
    async () => (await db.integrationConflict.findMany({ where: { conflictId: { startsWith: prefix } }, select: { conflictId: true } })).map((r) => r.conflictId),
    async (c) => !!(await db.integrationConflict.findUnique({ where: { conflictId: c } }))
  );
}
