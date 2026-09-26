import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const runtime = "nodejs";

// GET /api/v1/interoperability/exports/[jobId] — export job detail
// with the package inspector block (§58: id, counts, hashes,
// classification, integrity/signature status — no payload contents).
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const { jobId } = await params;
    const job = await db.manualExportJob.findUnique({
      where: { jobId },
      include: {
        requestedByOfficer: { select: { officerId: true, name: true } },
        requestedByDepartment: { select: { departmentCode: true, name: true } },
      },
    });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");
    const packageRow = job.packageId
      ? await db.packageRecord.findUnique({
          where: { packageId: job.packageId },
          include: { signatures: true, integrityChecks: true, files: true, downloads: true },
        })
      : null;
    return jsonOk({
      job: {
        jobId: job.jobId,
        packageId: job.packageId,
        exportType: job.exportType,
        status: job.status,
        classification: job.classification,
        recordCounts: job.recordCounts ? JSON.parse(job.recordCounts) : null,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        expiresAt: job.expiresAt,
        packageSize: job.packageSize,
        packageSha256: job.packageSha256,
        requestedBy: job.requestedByOfficer,
        department: job.requestedByDepartment.name,
      },
      package: packageRow
        ? {
            packageId: packageRow.packageId,
            packageType: packageRow.packageType,
            schemaVersion: packageRow.schemaVersion,
            sourceSystem: packageRow.sourceSystem,
            classification: packageRow.classification,
            caseCount: packageRow.caseCount,
            documentCount: packageRow.documentCount,
            evidenceCount: packageRow.evidenceCount,
            relationshipCount: packageRow.relationshipCount,
            packageIntegrity: packageRow.packageIntegrity,
            packageSha256: packageRow.packageSha256,
            manifestHash: packageRow.manifestHash,
            integrityAlgorithm: packageRow.integrityAlgorithm,
            signature: packageRow.signatures[0] ?? null,
            integrityChecks: packageRow.integrityChecks,
            fileCount: packageRow.files.length,
            downloadCount: packageRow.downloads.length,
          }
        : null,
      interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
