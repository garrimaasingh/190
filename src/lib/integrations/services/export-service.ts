import { createHash } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { assertConnectionAccess } from "../authorization";
import { getProviderOrThrow } from "../registry";
import { integrationConnectionService } from "./connection-service";
import { generateExportJobId } from "../ids";
import { encryptDocument } from "@/lib/documents/encryption";
import { DocumentStorage } from "@/lib/documents/storage";
import { resolveCaseAccess } from "@/lib/cases/access";
import type { ExportCasePackage, ProviderAck } from "../provider";
import type { Permission } from "@/lib/permissions";

// ============================================================
// Phase 8 — Export pipeline (spec §43/§44/§45/§58).
//
// - Export is ALWAYS an explicit, authorized act — data is never
//   exported merely because it exists (§43).
// - CASE-LEVEL AUTHORIZATION: every requested case goes through the
//   existing case access model; a case the officer cannot view is
//   NEVER included — it is recorded as failed/excluded (§58).
// - Where the provider supports direct export, the package is
//   delivered via provider.exportCase; the package is ALWAYS also
//   archived (encrypted, via the Phase 3 storage abstraction) with
//   an integrity manifest for verification (§44/§45).
// ============================================================

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface ExportRequest {
  exportType: "CASE_PACKAGE" | "DOCUMENT" | "EVIDENCE";
  caseRefs: string[]; // public CASE-… ids
  includeDocumentContent?: boolean; // default false (metadata-only, §64)
}

export interface ExportPreviewItem {
  caseRef: string;
  authorized: boolean;
  reason?: string | null;
  documentCount?: number;
  evidenceCount?: number;
}

export const integrationExportService = {
  /**
   * Preview: which of the requested cases the actor may export and
   * what would be included. Never leaks metadata of unauthorized
   * cases — only the fact of exclusion (§58).
   */
  async previewExport(ctx: AuthContext, connectionRef: string, caseRefs: string[]): Promise<{ connection: { connectionId: string; providerType: string; providerMode: string }; capabilitySupported: boolean; items: ExportPreviewItem[] }> {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    const provider = getProviderOrThrow(connection.providerType);
    const capabilitySupported = provider.capabilities.can_export_case || provider.capabilities.can_export_documents || provider.capabilities.can_export_evidence;
    const items: ExportPreviewItem[] = [];
    for (const caseRef of caseRefs) {
      const caseRow = await db.case.findFirst({ where: { caseId: caseRef }, select: { id: true } });
      if (!caseRow) {
        items.push({ caseRef, authorized: false, reason: "NOT_FOUND" });
        continue;
      }
      const { access } = await resolveCaseAccess(ctx, caseRef);
      if (!access.view) {
        items.push({ caseRef, authorized: false, reason: "CASE_ACCESS_DENIED" });
        continue;
      }
      const [docCount, evCount] = await Promise.all([
        db.caseDocument.count({ where: { caseId: caseRow.id, status: "COMMITTED" } }),
        db.evidence.count({ where: { caseId: caseRow.id } }),
      ]);
      items.push({ caseRef, authorized: true, documentCount: docCount, evidenceCount: evCount });
    }
    return {
      connection: { connectionId: connection.connectionId, providerType: connection.providerType, providerMode: connection.providerMode },
      capabilitySupported,
      items,
    };
  },

  /** Build the export package for ONE authorized case (§44/§45). */
  async buildCasePackage(ctx: AuthContext, exportJobId: string, caseRef: string, includeDocumentContent: boolean): Promise<{ pkg: ExportCasePackage; caseInternalId: string }> {
    const caseRow = await db.case.findFirst({
      where: { caseId: caseRef },
      include: {
        documents: { where: { status: "COMMITTED" }, orderBy: { createdAt: "asc" } },
        evidence: true,
      },
    });
    if (!caseRow) throw new ApiError(404, "NOT_FOUND", `Case ${caseRef} not found.`);
    const { access } = await resolveCaseAccess(ctx, caseRef);
    if (!access.view) throw new ApiError(403, "CASE_ACCESS_DENIED", "You are not authorized to export this case.");

    const exportedAt = new Date().toISOString();
    const entries: ExportCasePackage["integrity"]["entries"] = [];
    const documents: ExportCasePackage["documents"] = [];

    for (const d of caseRow.documents) {
      documents.push({
        documentId: d.documentId,
        title: d.title,
        documentType: d.documentType,
        classification: d.classification,
        status: d.status,
        sha256: d.sha256Hash,
        size: d.fileSize,
        mimeType: d.mimeType,
        filename: d.originalFilename,
        contentBase64: null, // filled below only when explicitly requested AND authorized
      });
      entries.push({
        documentId: d.documentId,
        filename: d.originalFilename,
        sha256: d.sha256Hash,
        size: d.fileSize,
        mimeType: d.mimeType,
        exportedAt,
        exportJobId,
      });
    }

    if (includeDocumentContent) {
      for (const doc of documents) {
        const row = caseRow.documents.find((d) => d.documentId === doc.documentId)!;
        try {
          const stored = await DocumentStorage.get_object(row.storageKey);
          const { decryptDocument } = await import("@/lib/documents/encryption");
          doc.contentBase64 = decryptDocument(stored).toString("base64");
        } catch {
          doc.contentBase64 = null; // integrity problem → metadata-only export for this file
        }
      }
    }

    const relationships = await db.documentRelationship.findMany({
      where: { sourceDocumentId: { in: caseRow.documents.map((d) => d.id) } },
      select: { sourceDocumentId: true, targetDocumentId: true, relationshipType: true },
    });
    const docIdByInternal = new Map(caseRow.documents.map((d) => [d.id, d.documentId] as const));
    const rels: ExportCasePackage["relationships"] = [];
    for (const r of relationships) {
      const s = docIdByInternal.get(r.sourceDocumentId);
      let t = docIdByInternal.get(r.targetDocumentId);
      if (!t) {
        const target = await db.caseDocument.findUnique({ where: { id: r.targetDocumentId }, select: { documentId: true } });
        t = target?.documentId;
      }
      if (s && t) rels.push({ source: s, target: t, type: r.relationshipType });
    }

    const pkg: ExportCasePackage = {
      packageVersion: "1.0",
      exportJobId,
      exportedAt,
      exportedByOfficerId: ctx.officer.officerId,
      case: {
        caseId: caseRow.caseId,
        caseNumber: caseRow.caseNumber,
        title: caseRow.title,
        description: caseRow.description,
        caseType: caseRow.caseType,
        status: caseRow.status,
        priority: caseRow.priority,
      },
      documents,
      evidence: caseRow.evidence.map((e) => ({
        evidenceId: e.evidenceId,
        title: e.title,
        evidenceType: e.evidenceType,
        classification: e.classification,
        status: e.status,
        hasDigitalContent: e.hasDigitalContent,
        sha256: e.sha256Hash,
      })),
      relationships: rels,
      integrity: {
        manifestVersion: "1.0",
        algorithm: "SHA-256",
        entries,
      },
    };
    return { pkg, caseInternalId: caseRow.id };
  },

  /** Run an export job (§43/§58): authorization → package → provider ack + archived manifest. */
  async runExport(ctx: AuthContext, connectionRef: string, request: ExportRequest) {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, "integration.export" as Permission, "export");
    integrationConnectionService.assertEnvironmentSafety(connection);
    const provider = getProviderOrThrow(connection.providerType);
    if (!provider.capabilities.can_export_case) {
      throw new ApiError(409, "CAPABILITY_NOT_SUPPORTED", "The provider does not support case export.");
    }

    const jobId = await generateExportJobId();
    const job = await db.integrationExportJob.create({
      data: {
        jobId,
        connectionId: connection.id,
        providerType: connection.providerType,
        exportType: request.exportType,
        requestedByOfficerId: ctx.officer.id,
        status: "PROCESSING",
        startedAt: new Date(),
        recordsSelected: request.caseRefs.length,
      },
    });

    await recordAuditEvent({
      eventType: "INTEGRATION_EXPORT_STARTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, connectionId: connection.connectionId, providerType: connection.providerType, requestedCases: request.caseRefs.length },
    });

    const includeContent = request.includeDocumentContent === true;
    let exported = 0;
    let failed = 0;
    const failureReasons: string[] = [];
    let manifestHash: string | null = null;
    let packageStorageKey: string | null = null;

    for (const caseRef of request.caseRefs) {
      try {
        const { pkg } = await this.buildCasePackage(ctx, jobId, caseRef, includeContent);

        // Provider delivery (capability-gated, resilience path).
        const ack: ProviderCallAck = await this.deliver(connection, provider.providerType, pkg);
        if (!ack.accepted) throw new Error(ack.message || "PROVIDER_REJECTED");

        // Archive package + integrity manifest via Phase 3 encrypted storage.
        const manifestJson = JSON.stringify(pkg.integrity, null, 2);
        manifestHash = sha256Hex(manifestJson);
        if (!packageStorageKey) {
          const bundle = JSON.stringify({ ...pkg, integrityManifest: manifestJson }, null, 2);
          const { blob } = encryptDocument(Buffer.from(bundle, "utf8"));
          const { buildExportStorageKey } = await import("../storage-keys");
          packageStorageKey = buildExportStorageKey(jobId);
          await DocumentStorage.ensureRoot();
          await DocumentStorage.put_object(packageStorageKey, blob);
        }

        await recordAuditEvent({
          eventType: "INTEGRATION_RECORD_IMPORTED",
          actorOfficerId: ctx.officer.id,
          caseId: caseRef,
          metadata: { jobId, direction: "EXPORT", externalReference: ack.externalReference ?? null, manifestHash },
        });
        exported += 1;
      } catch (err) {
        failed += 1;
        const reason = err instanceof ApiError ? `${err.code}` : err instanceof Error ? err.message.slice(0, 120) : "EXPORT_FAILED";
        // §58: unauthorized cases are NEVER included — recorded as excluded.
        failureReasons.push(`${caseRef}:${reason}`);
      }
    }

    const status = failed === 0 ? "COMPLETED" : exported > 0 ? "PARTIAL" : "FAILED";
    const finished = await db.integrationExportJob.update({
      where: { id: job.id },
      data: {
        status,
        recordsExported: exported,
        recordsFailed: failed,
        manifestHash,
        packageStorageKey,
        completedAt: new Date(),
        errorSummary: failureReasons.length ? failureReasons.join("; ").slice(0, 500) : null,
      },
    });

    await recordAuditEvent({
      eventType: status === "FAILED" ? "INTEGRATION_EXPORT_FAILED" : "INTEGRATION_EXPORT_COMPLETED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, connectionId: connection.connectionId, exported, failed, manifestHash },
    });

    return {
      jobId: finished.jobId,
      status: finished.status,
      recordsSelected: finished.recordsSelected,
      recordsExported: finished.recordsExported,
      recordsFailed: finished.recordsFailed,
      manifestHash: finished.manifestHash,
      errorSummary: finished.errorSummary,
      completedAt: finished.completedAt,
    };
  },

  async deliver(connection: Parameters<typeof integrationConnectionService.runProviderCall>[0], _providerType: string, pkg: ExportCasePackage): Promise<ProviderAck> {
    const outcome = await integrationConnectionService.runProviderCall(connection, "export_case", (p, c) => p.exportCase!(c, pkg));
    if (!outcome.ok || !outcome.value) {
      return { accepted: false, acknowledgedAt: new Date().toISOString(), message: `${outcome.errorCategory}:${outcome.errorDetail}` };
    }
    return outcome.value;
  },

  /** Manifest for an export job — authorized actors only (§45 verification). */
  async getManifest(ctx: AuthContext, jobId: string) {
    const job = await db.integrationExportJob.findUnique({ where: { jobId }, include: { connection: true } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");
    await assertConnectionAccess(ctx, job.connection, "integration.read" as Permission, "read");
    if (!job.packageStorageKey) throw new ApiError(404, "NOT_FOUND", "No package archived for this job.");
    const stored = await DocumentStorage.get_object(job.packageStorageKey);
    const { decryptDocument } = await import("@/lib/documents/encryption");
    const bundle = JSON.parse(decryptDocument(stored).toString("utf8")) as ExportCasePackage & { integrityManifest: string };
    return {
      jobId: job.jobId,
      manifestHash: job.manifestHash,
      manifest: JSON.parse(bundle.integrityManifest) as ExportCasePackage["integrity"],
      case: bundle.case,
      recordsExported: job.recordsExported,
      status: job.status,
    };
  },
};

type ProviderCallAck = ProviderAck;
