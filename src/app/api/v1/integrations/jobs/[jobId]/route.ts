import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertConnectionAccess } from "@/lib/integrations/authorization";

export const runtime = "nodejs";

// GET /api/v1/integrations/jobs/[jobId] — job detail with staged
// records (§21/§42). Structured validation errors are returned;
// raw external payloads are never included.
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEGRATION_READ);
    const { jobId } = await params;

    const importJob = await db.integrationImportJob.findUnique({
      where: { jobId },
      include: {
        connection: true,
        requestedByOfficer: { select: { officerId: true, name: true } },
        records: { orderBy: { createdAt: "asc" } },
      },
    });
    const exportJob = importJob ? null : await db.integrationExportJob.findUnique({
      where: { jobId },
      include: { connection: true, requestedByOfficer: { select: { officerId: true, name: true } } },
    });
    const job = importJob ?? exportJob;
    if (!job) throw new ApiError(404, "NOT_FOUND", "Integration job not found.");
    await assertConnectionAccess(ctx, job.connection, PERMISSIONS.INTEGRATION_READ, "read");

    const base = {
      jobId: job.jobId,
      kind: importJob ? "IMPORT" : "EXPORT",
      providerType: job.providerType,
      status: job.status,
      connection: { connectionId: job.connection.connectionId, providerType: job.connection.providerType, providerMode: job.connection.providerMode, displayName: job.connection.displayName },
      requestedBy: job.requestedByOfficer,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      errorSummary: job.errorSummary,
      createdAt: job.createdAt,
    };

    if (importJob) {
      return jsonOk({
        ...base,
        importType: importJob.importType,
        counters: {
          received: importJob.recordsReceived,
          imported: importJob.recordsImported,
          rejected: importJob.recordsRejected,
          conflicted: importJob.recordsConflicted,
          skipped: importJob.recordsSkipped,
        },
        schemaVersion: importJob.schemaVersion,
        mappingVersion: importJob.mappingVersion,
        records: importJob.records.map((r) => ({
          id: r.id,
          externalRecordId: r.externalRecordId,
          recordType: r.recordType,
          rawReference: r.rawReference,
          validationStatus: r.validationStatus,
          validationErrors: r.validationErrors ? JSON.parse(r.validationErrors) : null,
          conflictStatus: r.conflictStatus,
          processingStatus: r.processingStatus,
          errorDetails: r.errorDetails,
          centralRecordRef: r.centralRecordRef,
          createdAt: r.createdAt,
        })),
      });
    }
    return jsonOk({
      ...base,
      exportType: exportJob!.exportType,
      recordsSelected: exportJob!.recordsSelected,
      recordsExported: exportJob!.recordsExported,
      recordsFailed: exportJob!.recordsFailed,
      manifestHash: exportJob!.manifestHash,
      hasPackage: !!exportJob!.packageStorageKey,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
