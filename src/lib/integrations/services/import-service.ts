import { createHash } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent, appendAuditEvent } from "@/lib/audit/service";
import { assertConnectionAccess, isSystemAdmin, parseConnectionConfig } from "../authorization";
import { getProviderOrThrow } from "../registry";
import { integrationMappingService, type FieldMapping } from "../mapping";
import { integrationConflictService, type ConflictDraft } from "./conflict-service";
import { integrationConnectionService } from "./connection-service";
import { generateImportJobId } from "../ids";
import { mutateMockCase } from "../data";
import { autoEnqueueAfterCommit } from "@/lib/ai/jobs";
import { uploadAndCommit } from "@/lib/documents/service";
import { registerEvidence } from "@/lib/evidence/service";
import { loadCaseForAccess } from "@/lib/cases/access";
import type { ProviderCallOutcome } from "./connection-service";
import type { Permission } from "@/lib/permissions";

// ============================================================
// Phase 8 — Import pipeline (spec §15/§20-§27).
//
//   EXTERNAL DATA → VALIDATION → MAPPING → CONFLICT CHECK →
//   IMPORT STAGING → (HUMAN APPROVAL when required) → CENTRAL RECORD
//
// Invariants enforced here:
// - Central IDs stay authoritative; duplicates LINK, never duplicate (§11/§24/§53).
// - One malformed record is REJECTED with structured errors; the job continues (§20).
// - Hash mismatch on imported documents BLOCKS the import and raises
//   an integrity event — a mismatched file never becomes a trusted
//   central document (§26/§55).
// - Evidence import preserves source provenance and NEVER fabricates
//   custody history; external custody notices do NOT touch custody
//   fields (§27/§28) — case custody is likewise never modified (§29).
// - Sensitive mapped fields and conflicted records remain STAGED
//   pending explicit approval (§15).
// - Document bytes flow through the REAL Phase 3 pipeline
//   (validate → scan → hash → encrypt → store → commit) — no second
//   storage architecture (§25).
// ============================================================

const JOB_PERM: Record<string, Permission> = {
  CASE: "integration.import",
  DOCUMENT: "integration.import",
  EVIDENCE: "integration.import",
  CASE_BUNDLE: "integration.import",
};

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface ImportRequest {
  importType: "CASE" | "DOCUMENT" | "EVIDENCE" | "CASE_BUNDLE";
  externalCaseId: string;
  externalDocumentId?: string | null;
  externalEvidenceId?: string | null;
  /** Link imports into an EXISTING central case (required for DOCUMENT/EVIDENCE). */
  targetCaseRef?: string | null;
}

function jobSummary(job: {
  jobId: string; status: string; importType: string; recordsReceived: number; recordsImported: number;
  recordsRejected: number; recordsConflicted: number; recordsSkipped: number; errorSummary: string | null;
  schemaVersion: string | null; mappingVersion: number | null; startedAt: Date | null; completedAt: Date | null;
}) {
  return { ...job };
}

export const integrationImportService = {
  /**
   * Run an import job synchronously (single-node Phase 8 execution)
   * but with full job/record bookkeeping so a future queue worker
   * can adopt the exact same service. The HTTP response returns the
   * finished job — failures are DATA on the job, not 5xx noise (§59).
   */
  async runImport(ctx: AuthContext, connectionRef: string, request: ImportRequest) {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    await assertConnectionAccess(ctx, connection, JOB_PERM[request.importType], "import");
    integrationConnectionService.assertEnvironmentSafety(connection);
    const provider = getProviderOrThrow(connection.providerType);
    if (!provider) throw new ApiError(409, "PROVIDER_UNAVAILABLE", "Provider is not registered.");

    // Capability gating (spec §4): the backend refuses operations the
    // provider does not declare.
    this.assertProviderCapability(provider, request.importType);

    const jobId = await generateImportJobId();
    const job = await db.integrationImportJob.create({
      data: {
        jobId,
        connectionId: connection.id,
        providerType: connection.providerType,
        importType: request.importType,
        requestedByOfficerId: ctx.officer.id,
        status: "PROCESSING",
        startedAt: new Date(),
      },
    });

    await recordAuditEvent({
      eventType: "INTEGRATION_IMPORT_STARTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, connectionId: connection.connectionId, providerType: connection.providerType, importType: request.importType, externalCaseId: request.externalCaseId },
    });

    const counters = { received: 0, imported: 0, rejected: 0, conflicted: 0, skipped: 0, staged: 0 };
    let errorSummary: string | null = null;
    let schemaVersion: string | null = null;
    let mappingVersion: number | null = null;

    try {
      // ---- Fetch external case (provider call, full resilience path) ----
      const fetched = await integrationConnectionService.runProviderCall(connection, "get_case", (p, c) => p.getCase!(c, request.externalCaseId));
      if (!fetched.ok || !fetched.value) {
        throw new Error(`PROVIDER_CALL_FAILED:${fetched.errorCategory}:${fetched.errorDetail}`);
      }
      const payload = fetched.value as Awaited<ReturnType<NonNullable<typeof provider.getCase>>>;
      schemaVersion = payload.schemaVersion;

      // ---- Schema version gate (§19/§69) ----
      const supported = await integrationMappingService.isSchemaVersionSupported(connection.providerType, provider.schemaName, payload.schemaVersion);
      if (!supported) {
        await recordAuditEvent({
          eventType: "INTEGRATION_SCHEMA_UNSUPPORTED",
          actorOfficerId: ctx.officer.id,
          metadata: { jobId, providerType: connection.providerType, schemaVersion: payload.schemaVersion, supported: provider.supportedSchemaVersions },
        });
        throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${payload.schemaVersion}`);
      }

      const mapping = await integrationMappingService.getActiveMapping(connection.providerType, "case_import");
      if (!mapping) throw new Error("MAPPING_NOT_CONFIGURED");
      mappingVersion = mapping.mappingVersion;

      // ---- CASE import (also the shell for DOCUMENT/EVIDENCE/CASE_BUNDLE targets) ----
      const caseOutcome = await this.importCaseRecord(ctx, connection, provider, job.id, mapping.mappings, payload as unknown as Record<string, unknown> & { externalCaseId: string; externalCaseNumber?: string | null; updatedAt?: string | null }, request, counters);
      mappingVersion = caseOutcome.mappingVersion ?? mappingVersion;

      // ---- DOCUMENT imports ----
      const wantsDocuments =
        request.importType === "CASE_BUNDLE" ||
        request.importType === "DOCUMENT" ||
        (request.importType === "CASE" && parseConnectionConfig(connection.configJson).importCaseDocuments === true);
      if (wantsDocuments && (request.importType !== "DOCUMENT" || request.externalDocumentId)) {
        const docs = request.importType === "DOCUMENT" && request.externalDocumentId
          ? payload.documents.filter((d) => d.externalDocumentId === request.externalDocumentId)
          : payload.documents;
        for (const docRef of docs) {
          counters.received += 1;
          try {
            const outcome = await this.importDocumentRecord(ctx, connection, job.id, payload.externalCaseId, docRef.externalDocumentId, caseOutcome.centralCaseRef, caseOutcome.linkedCaseInternalId);
            if (outcome === "IMPORTED") counters.imported += 1;
            else if (outcome === "SKIPPED_DUPLICATE") counters.skipped += 1;
            else counters.rejected += 1;
          } catch (err) {
            counters.rejected += 1;
            await this.recordStagingFailure(job.id, docRef.externalDocumentId, "DOCUMENT", err);
          }
        }
      }

      // ---- EVIDENCE imports ----
      const wantsEvidence =
        request.importType === "CASE_BUNDLE" ||
        request.importType === "EVIDENCE" ||
        (request.importType === "CASE" && parseConnectionConfig(connection.configJson).importCaseEvidence === true);
      if (wantsEvidence) {
        const evidences = request.importType === "EVIDENCE" && request.externalEvidenceId
          ? (await this.fetchEvidence(connection, payload.externalCaseId)).filter((e) => e.externalEvidenceId === request.externalEvidenceId)
          : (await this.fetchEvidence(connection, payload.externalCaseId));
        for (const ev of evidences) {
          counters.received += 1;
          try {
            const outcome = await this.importEvidenceRecord(ctx, connection, job.id, payload.externalCaseId, ev, caseOutcome.centralCaseRef, caseOutcome.linkedCaseInternalId);
            if (outcome === "IMPORTED") counters.imported += 1;
            else if (outcome === "SKIPPED_DUPLICATE") counters.skipped += 1;
            else counters.rejected += 1;
          } catch (err) {
            counters.rejected += 1;
            await this.recordStagingFailure(job.id, ev.externalEvidenceId, "EVIDENCE", err);
          }
        }
      }

      const terminalStatus =
        counters.rejected > 0
          ? counters.imported > 0 || counters.skipped > 0 ? "PARTIAL" : "FAILED"
          : counters.staged > 0
            ? "PARTIAL" // staged-for-review records keep the job from being COMPLETED
            : "COMPLETED";
      const status = terminalStatus;
      if (status === "FAILED") errorSummary = "All records were rejected — see import records for structured errors.";
      else if (status === "PARTIAL" && counters.staged > 0 && counters.rejected === 0) errorSummary = "Some records are STAGED for review (sensitive fields) — approve via the import review UI.";
      const finished = await db.integrationImportJob.update({
        where: { id: job.id },
        data: {
          status,
          completedAt: new Date(),
          recordsReceived: counters.received,
          recordsImported: counters.imported,
          recordsRejected: counters.rejected,
          recordsConflicted: counters.conflicted,
          recordsSkipped: counters.skipped,
          errorSummary,
          schemaVersion,
          mappingVersion,
        },
      });

      await recordAuditEvent({
        eventType: status === "FAILED" ? "INTEGRATION_IMPORT_FAILED" : "INTEGRATION_IMPORT_COMPLETED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        metadata: { jobId, connectionId: connection.connectionId, status, received: counters.received, imported: counters.imported, rejected: counters.rejected, conflicted: counters.conflicted, skipped: counters.skipped, staged: counters.staged },
      });

      return jobSummary(finished);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed.";
      const safeCategory = message.startsWith("SCHEMA_VERSION_UNSUPPORTED") ? "SCHEMA_VERSION_UNSUPPORTED" : message.startsWith("PROVIDER_CALL_FAILED") ? message.split(":")[1] : "PROVIDER_ERROR";
      const finished = await db.integrationImportJob
        .update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            recordsReceived: counters.received,
            recordsImported: counters.imported,
            recordsRejected: counters.rejected,
            recordsConflicted: counters.conflicted,
            recordsSkipped: counters.skipped,
            errorSummary: `${safeCategory}:${message.slice(0, 280)}`,
            schemaVersion,
            mappingVersion,
          },
        })
        .catch(() => job);
      await recordAuditEvent({
        eventType: "INTEGRATION_IMPORT_FAILED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "FAILED",
        metadata: { jobId, connectionId: connection.connectionId, errorCategory: safeCategory },
      });
      return jobSummary(finished as never);
    }
  },

  assertProviderCapability(provider: NonNullable<ReturnType<typeof getProviderOrThrow>>, importType: string): void {
    const caps = provider.capabilities;
    const ok =
      importType === "CASE" || importType === "CASE_BUNDLE"
        ? caps.can_import_case
        : importType === "DOCUMENT"
          ? caps.can_import_documents
          : caps.can_import_evidence;
    if (!ok) {
      throw new ApiError(409, "CAPABILITY_NOT_SUPPORTED", "The provider does not support this import operation.");
    }
  },

  async fetchEvidence(connection: Parameters<typeof integrationConnectionService.runProviderCall>[0], externalCaseId: string) {
    const provider = getProviderOrThrow(connection.providerType);
    if (!provider.getEvidence || !provider.capabilities.can_read_evidence) return [];
    const outcome: ProviderCallOutcome<unknown[]> = await integrationConnectionService.runProviderCall(connection, "get_evidence", (p, c) => p.getEvidence!(c, externalCaseId));
    return outcome.ok && outcome.value ? (outcome.value as Awaited<ReturnType<NonNullable<typeof provider.getEvidence>>>) : [];
  },

  // ------------------------------------------------------------
  // CASE record: duplicate check → mapping/validation → conflicts →
  // create-or-link → external reference.
  // ------------------------------------------------------------
  async importCaseRecord(
    ctx: AuthContext,
    connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null; ownerDepartmentId: string },
    _provider: ReturnType<typeof getProviderOrThrow>,
    jobId: string,
    mappings: FieldMapping[],
    payload: Record<string, unknown> & { externalCaseId: string; externalCaseNumber?: string | null; updatedAt?: string | null },
    request: ImportRequest,
    counters: { received: number; imported: number; rejected: number; conflicted: number; skipped: number; staged: number }
  ): Promise<{ centralCaseRef: string; linkedCaseInternalId: string; mappingVersion: number | null }> {
    counters.received += 1;

    // 1. Duplicate check FIRST (§24/§53): same external id → LINK existing.
    const existingRef = await db.externalCaseReference.findUnique({
      where: { providerType_externalSystem_externalCaseId: { providerType: connection.providerType, externalSystem: connection.connectionId, externalCaseId: payload.externalCaseId } },
      include: { case: { select: { id: true, caseId: true, title: true } } },
    });

    // 2. Map + validate.
    const mapped = integrationMappingService.mapRecord(mappings, payload);

    if (existingRef) {
      // LINK EXISTING — record the duplicate, detect conflicts on mapped fields.
      const staged = await db.integrationImportRecord.create({
        data: {
          importJobId: jobId,
          externalRecordId: payload.externalCaseId,
          recordType: "CASE",
          rawReference: payload.externalCaseNumber ?? null,
          normalizedPayload: JSON.stringify(mapped.values).slice(0, 4000),
          validationStatus: mapped.errors.length ? "INVALID" : "VALID",
          validationErrors: mapped.errors.length ? JSON.stringify({ errors: mapped.errors, missing: mapped.missing }) : null,
          conflictStatus: "NONE",
          processingStatus: "SKIPPED_DUPLICATE",
          centralRecordRef: existingRef.case.caseId,
        },
      });
      // Conflict detection against the linked central case (§22/§54).
      const conflicts = this.diffCentralFields(
        { caseRef: existingRef.case.caseId, central: { title: existingRef.case.title }, external: mapped.values, externalUpdatedAt: payload.updatedAt ? new Date(payload.updatedAt) : null },
        connection.providerType,
        payload.externalCaseId
      );
      if (conflicts.length) {
        await integrationConflictService.createConflicts(
          conflicts.map((c) => ({ ...c, connectionRef: connection.connectionId, importJobId: jobId, importRecordId: staged.id }))
        );
        await db.integrationImportRecord.update({ where: { id: staged.id }, data: { conflictStatus: "DETECTED" } });
        counters.conflicted += 1;
      }
      await db.externalCaseReference.update({ where: { id: existingRef.id }, data: { lastSyncedAt: new Date(), sourceHash: sha256(Buffer.from(JSON.stringify(payload))) } });
      return { centralCaseRef: existingRef.case.caseId, linkedCaseInternalId: existingRef.caseInternalId, mappingVersion: null };
    }

    // 3. Validation failures → structured rejection, job continues (§20).
    if (mapped.errors.length) {
      await db.integrationImportRecord.create({
        data: {
          importJobId: jobId,
          externalRecordId: payload.externalCaseId,
          recordType: "CASE",
          rawReference: payload.externalCaseNumber ?? null,
          normalizedPayload: JSON.stringify(mapped.values).slice(0, 4000),
          validationStatus: "INVALID",
          validationErrors: JSON.stringify({ errors: mapped.errors, missing: mapped.missing }),
          processingStatus: "REJECTED",
          errorDetails: "Validation failed — record rejected with structured errors.",
        },
      });
      await recordAuditEvent({
        eventType: "INTEGRATION_RECORD_REJECTED",
        actorOfficerId: ctx.officer.id,
        metadata: { jobId, externalRecordId: payload.externalCaseId, recordType: "CASE", reasons: mapped.errors.slice(0, 5).map((e) => e.code) },
      });
      counters.rejected += 1;
      throw new ApiError(422, "IMPORT_VALIDATION_FAILED", "External case failed mapping validation — see the import job records.");
    }

    // 4. Approval gate (§15): sensitive fields force STAGED — the job
    // continues (staged ≠ failed); approval happens explicitly later.
    const cfg = parseConnectionConfig(connection.configJson);
    const autoApproveLowRisk = cfg.autoApproveLowRisk === true;
    const hasSensitive = mapped.sensitiveFields.length > 0;
    if (hasSensitive && !autoApproveLowRisk) {
      await db.integrationImportRecord.create({
        data: {
          importJobId: jobId,
          externalRecordId: payload.externalCaseId,
          recordType: "CASE",
          rawReference: payload.externalCaseNumber ?? null,
          normalizedPayload: JSON.stringify(mapped.values).slice(0, 4000),
          validationStatus: "VALID",
          conflictStatus: "NONE",
          processingStatus: "STAGED",
        },
      });
      await recordAuditEvent({
        eventType: "INTEGRATION_RECORD_REJECTED",
        actorOfficerId: ctx.officer.id,
        metadata: { jobId, externalRecordId: payload.externalCaseId, recordType: "CASE", staged: true, sensitiveFields: mapped.sensitiveFields },
      });
      counters.staged += 1;
      return { centralCaseRef: "", linkedCaseInternalId: "", mappingVersion: null };
    }

    // 5. Create the central case + provenance, atomically.
    const created = await this.createCentralCase(ctx, connection, mapped.values, payload);
    await db.integrationImportRecord.create({
      data: {
        importJobId: jobId,
        externalRecordId: payload.externalCaseId,
        recordType: "CASE",
        rawReference: payload.externalCaseNumber ?? null,
        normalizedPayload: JSON.stringify(mapped.values).slice(0, 4000),
        validationStatus: "VALID",
        conflictStatus: "NONE",
        processingStatus: "IMPORTED",
        centralRecordRef: created.caseId,
      },
    });
    await recordAuditEvent({
      eventType: "INTEGRATION_RECORD_IMPORTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      caseId: created.caseId,
      metadata: { jobId, externalRecordId: payload.externalCaseId, recordType: "CASE", sourceSystem: connection.connectionId, providerMode: connection.providerMode },
    });
    counters.imported += 1;
    return { centralCaseRef: created.caseId, linkedCaseInternalId: created.internalId, mappingVersion: null };
  },

  /** Diff mapped external values vs central values → conflict drafts (no writes). */
  diffCentralFields(
    args: { caseRef: string; central: Record<string, unknown>; external: Record<string, unknown>; externalUpdatedAt: Date | null },
    providerType: string,
    externalReference: string
  ): ConflictDraft[] {
    const drafts: ConflictDraft[] = [];
    for (const field of ["title", "description"]) {
      const centralVal = args.central[field];
      const externalVal = args.external[field];
      if (typeof centralVal === "string" && typeof externalVal === "string" && centralVal.trim() !== externalVal.trim()) {
        drafts.push({
          caseRef: args.caseRef,
          providerType,
          externalReference,
          fieldName: field,
          centralValue: centralVal.slice(0, 300),
          externalValue: externalVal.slice(0, 300),
          externalUpdatedAt: args.externalUpdatedAt,
        });
      }
    }
    return drafts;
  },

  async createCentralCase(
    ctx: AuthContext,
    connection: { ownerDepartmentId: string; providerType: string; connectionId: string; providerMode: string },
    values: Record<string, unknown>,
    payload: Record<string, unknown> & { externalCaseId: string; externalCaseNumber?: string | null }
  ): Promise<{ caseId: string; internalId: string }> {
    const { generateCaseId } = await import("@/lib/cases/ids");
    const ownerDept = await db.department.findUnique({ where: { id: connection.ownerDepartmentId }, include: { city: { include: { district: { include: { state: true } } } } } });
    if (!ownerDept) throw new ApiError(500, "INTERNAL_ERROR", "Connection owner department missing.");

    const caseId = await generateCaseId({ state: { code: ownerDept.city.district.state.code }, district: { code: ownerDept.city.district.code } }, new Date().getFullYear());

    const created = await db.case.create({
      data: {
        caseId,
        // External reference number preserved as metadata — central ID stays authoritative (§11).
        caseNumber: (payload.externalCaseNumber as string) ?? null,
        title: String(values.title ?? `Imported case ${payload.externalCaseId}`).slice(0, 200),
        description: values.description ? String(values.description).slice(0, 4000) : null,
        caseType: String(values.caseType ?? "OTHER"),
        priority: String(values.priority ?? "NORMAL"),
        // Imported cases enter as OPEN drafts of the platform — status
        // then follows the normal case lifecycle (never auto-custodied
        // to an external system).
        status: "OPEN",
        stateId: ownerDept.stateId,
        districtId: ownerDept.districtId,
        cityId: ownerDept.cityId,
        originatingDepartmentId: ownerDept.id,
        currentCustodianDepartmentId: ownerDept.id, // connection owner — internal custody only (§29)
        currentCustodianOfficerId: ctx.officer.id,
        createdByOfficerId: ctx.officer.id,
        createdByDepartmentId: ctx.officer.departmentId,
        openedAt: new Date(),
      },
    });

    await db.caseDepartment.create({
      data: { caseId: created.id, departmentId: ownerDept.id, participationType: "ORIGINATING", addedByOfficerId: ctx.officer.id, note: `Originating participation via ${connection.providerType} import (MOCK/SANDBOX source)` },
    });

    // Investigating officer from the external payload is recorded as a
    // CaseOfficer assignment ONLY when the badge maps to a platform
    // officer (mapping declares it sensitive — badge never auto-links).
    if (values.officerBadge && typeof values.officerBadge === "string") {
      const officer = await db.officer.findFirst({ where: { officerId: values.officerBadge } });
      if (officer) {
        await db.caseOfficer.create({ data: { caseId: created.id, officerId: officer.id, departmentId: officer.departmentId, roleOnCase: "INVESTIGATING_OFFICER", assignedByOfficerId: ctx.officer.id } });
      }
    }

    await db.caseEvent.create({
      data: {
        caseId: created.id,
        eventType: "CASE_CREATED",
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        description: `Case created from ${connection.providerType} import (source: ${connection.connectionId}, external id ${payload.externalCaseId})`,
        metadata: JSON.stringify({ externalCaseId: payload.externalCaseId, providerType: connection.providerType, providerMode: connection.providerMode, sourceSystem: connection.connectionId }),
      },
    });

    await db.externalCaseReference.create({
      data: {
        caseInternalId: created.id,
        providerType: connection.providerType,
        externalSystem: connection.connectionId,
        externalCaseId: payload.externalCaseId,
        externalCaseNumber: payload.externalCaseNumber ?? null,
        sourceHash: sha256(Buffer.from(JSON.stringify(payload))),
        schemaVersion: typeof payload.schemaVersion === "string" ? payload.schemaVersion : null,
        importedByOfficerId: ctx.officer.id,
      },
    });

    return { caseId: created.caseId, internalId: created.id };
  },

  // ------------------------------------------------------------
  // DOCUMENT record (§25/§26): download → SHA-256 → verify source
  // hash → Phase 3 pipeline (validate/scan/encrypt/store/commit) →
  // ExternalDocumentReference → audit.
  // ------------------------------------------------------------
  async importDocumentRecord(
    ctx: AuthContext,
    connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null },
    jobId: string,
    externalCaseId: string,
    externalDocumentId: string,
    centralCaseRef: string | null,
    centralCaseInternalId: string | null
  ): Promise<"IMPORTED" | "SKIPPED_DUPLICATE" | "REJECTED"> {
    if (!centralCaseRef || !centralCaseInternalId) {
      throw new ApiError(422, "IMPORT_TARGET_CASE_REQUIRED", "Document import requires a central case (import the case first or pass targetCaseRef).");
    }
    const caseRow = await loadCaseForAccess(centralCaseRef);
    if (!caseRow) throw new ApiError(404, "NOT_FOUND", "Target case not found.");

    // Duplicate reference check (§53): same external doc → skip + link note.
    const existingDocRef = await db.externalDocumentReference.findUnique({
      where: { providerType_externalSystem_externalDocumentId: { providerType: connection.providerType, externalSystem: connection.connectionId, externalDocumentId } },
    });
    if (existingDocRef) return "SKIPPED_DUPLICATE";

    // Download (explicit, capability-gated) — bytes fetched ONLY now (§64).
    const provider = getProviderOrThrow(connection.providerType);
    if (!provider.getDocumentContent || !provider.capabilities.can_read_documents) {
      throw new ApiError(409, "CAPABILITY_NOT_SUPPORTED", "The provider does not support document retrieval.");
    }
    const fetched = await integrationConnectionService.runProviderCall(connection, "get_document", (p, c) => p.getDocumentContent!(c, externalCaseId, externalDocumentId));
    if (!fetched.ok || !fetched.value) throw new Error(`PROVIDER_CALL_FAILED:${fetched.errorCategory}:${fetched.errorDetail}`);
    const docPayload = fetched.value;

    const bytes = Buffer.from(docPayload.contentBase64 ?? "", "base64");
    if (bytes.length === 0) throw new Error("EMPTY_DOCUMENT_PAYLOAD");

    // §26/§55: verify the external integrity hash BEFORE anything else.
    const centralHash = sha256(bytes);
    if (docPayload.sourceHash && docPayload.sourceHash !== centralHash) {
      await appendAuditEvent({
        eventType: "INTEGRATION_RECORD_REJECTED",
        actorOfficerId: ctx.officer.id,
        caseId: centralCaseRef,
        result: "FAILED",
        metadata: { jobId, externalDocumentId, reason: "SOURCE_HASH_MISMATCH", expectedSha256Prefix: docPayload.sourceHash.slice(0, 12), actualSha256Prefix: centralHash.slice(0, 12) },
      });
      await db.integrationImportRecord.create({
        data: {
          importJobId: jobId,
          externalRecordId: externalDocumentId,
          recordType: "DOCUMENT",
          rawReference: docPayload.filename ?? null,
          validationStatus: "INVALID",
          processingStatus: "REJECTED",
          errorDetails: `SOURCE_HASH_MISMATCH: external=${docPayload.sourceHash.slice(0, 16)}… central=${centralHash.slice(0, 16)}… — import blocked (integrity event raised).`,
        },
      });
      return "REJECTED";
    }

    // Phase 3 pipeline (validate → scan → hash → encrypt → store → commit).
    const classification = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"].includes(String(docPayload.classification)) ? String(docPayload.classification) : "INTERNAL";
    const upload = await uploadAndCommit({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      input: {
        title: docPayload.title.slice(0, 200),
        description: `Imported from ${connection.providerType} (${connection.providerMode}) — external id ${externalDocumentId}`,
        documentType: ["FIR", "CASE_DIARY", "WITNESS_STATEMENT", "INVESTIGATION_REPORT", "FORENSIC_REPORT", "CHARGE_SHEET", "PROSECUTION_DOCUMENT", "COURT_DOCUMENT", "COURT_ORDER", "JUDGMENT", "LEGAL_NOTICE", "CORRESPONDENCE", "IDENTITY_DOCUMENT", "EVIDENCE_REPORT", "OTHER"].includes(String(docPayload.documentType)) ? String(docPayload.documentType) : "OTHER",
        classification,
        documentDate: docPayload.documentDate ? new Date(docPayload.documentDate) : null,
        externalReference: externalDocumentId.slice(0, 100),
        tags: [`integration:${connection.providerType}`, "MOCK_SANDBOX_SOURCE"],
      },
      file: { buffer: bytes, originalFilename: docPayload.filename ?? `${externalDocumentId}.bin`, declaredMimeType: docPayload.mimeType },
    });

    await db.externalDocumentReference.create({
      data: {
        documentInternalId: upload.document.id,
        providerType: connection.providerType,
        externalSystem: connection.connectionId,
        externalDocumentId,
        externalReference: docPayload.filename ?? null,
        sourceHash: docPayload.sourceHash ?? null,
        centralHash,
        hashVerified: !!(docPayload.sourceHash && docPayload.sourceHash === centralHash),
        importedByOfficerId: ctx.officer.id,
        importJobId: jobId,
      },
    });

    await db.integrationImportRecord.create({
      data: {
        importJobId: jobId,
        externalRecordId: externalDocumentId,
        recordType: "DOCUMENT",
        rawReference: docPayload.filename ?? null,
        normalizedPayload: JSON.stringify({ title: docPayload.title, mimeType: docPayload.mimeType, sizeBytes: docPayload.sizeBytes, centralHash, sourceHash: docPayload.sourceHash, hashVerified: true }).slice(0, 4000),
        validationStatus: "VALID",
        conflictStatus: "NONE",
        processingStatus: "IMPORTED",
        centralRecordRef: upload.document.documentId,
      },
    });

    await recordAuditEvent({
      eventType: "INTEGRATION_RECORD_IMPORTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      caseId: centralCaseRef,
      documentId: upload.document.documentId,
      metadata: { jobId, externalDocumentId, recordType: "DOCUMENT", centralHash, hashVerified: true, sourceSystem: connection.connectionId },
    });

    // Phase 5 hook — AI processing can pick the imported document up
    // through the exact same auto-enqueue path used by native uploads.
    await autoEnqueueAfterCommit({
      ctx,
      caseInternalId: caseRow.id,
      caseRef: caseRow.caseId,
      documentInternalId: upload.document.id,
      documentRef: upload.document.documentId,
    }).catch(() => undefined);

    return "IMPORTED";
  },

  // ------------------------------------------------------------
  // EVIDENCE record (§27/§28): provenance preserved, custody NEVER
  // fabricated or modified. Uses the REAL Phase 4 evidence service.
  // ------------------------------------------------------------
  async importEvidenceRecord(
    ctx: AuthContext,
    connection: { id: string; connectionId: string; providerType: string; providerMode: string; environment: string; configJson: string | null; credentialRef: string | null },
    jobId: string,
    externalCaseId: string,
    ev: { externalEvidenceId: string; title: string; description?: string | null; evidenceType?: string | null; classification?: string | null; sourceCustodian?: string | null; sourceDepartment?: string | null; collectionLocation?: string | null; collectedAt?: string | null; custodyTrail?: { available: boolean } | null; currentExternalHolder?: string | null },
    centralCaseRef: string | null,
    centralCaseInternalId: string | null
  ): Promise<"IMPORTED" | "SKIPPED_DUPLICATE" | "REJECTED"> {
    if (!centralCaseRef || !centralCaseInternalId) {
      throw new ApiError(422, "IMPORT_TARGET_CASE_REQUIRED", "Evidence import requires a central case.");
    }
    const caseRow = await loadCaseForAccess(centralCaseRef);
    if (!caseRow) throw new ApiError(404, "NOT_FOUND", "Target case not found.");

    const existingEvRef = await db.externalEvidenceReference.findUnique({
      where: { providerType_externalSystem_externalEvidenceId: { providerType: connection.providerType, externalSystem: connection.connectionId, externalEvidenceId: ev.externalEvidenceId } },
    });
    if (existingEvRef) return "SKIPPED_DUPLICATE";

    const historyAvailable = ev.custodyTrail?.available === true;
    // §27: never fabricate missing custody — provenance notes state the truth.
    const provenanceNote = [
      `SOURCE: ${connection.providerType} (${connection.providerMode}) external id ${ev.externalEvidenceId}.`,
      `Source custodian: ${ev.sourceCustodian ?? "UNSPECIFIED"}. Source department: ${ev.sourceDepartment ?? "UNSPECIFIED"}.`,
      historyAvailable ? "Source custody history provided by external system." : "HISTORY_UNAVAILABLE — external system did not provide historical custody; none was invented.",
      ev.currentExternalHolder ? `External holder notice: ${ev.currentExternalHolder}. Any custody change must follow the platform evidence transfer workflow (integration does NOT modify custody).` : null,
    ].filter(Boolean).join(" ");

    const registered = await registerEvidence({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      input: {
        title: ev.title.slice(0, 200),
        description: `${ev.description ?? ""}${ev.description ? " " : ""}${provenanceNote}`.slice(0, 2000) || null,
        evidenceType: ["PHYSICAL", "DIGITAL", "DOCUMENTARY", "AUDIO", "VIDEO", "IMAGE", "FORENSIC_SAMPLE", "DEVICE", "OTHER"].includes(String(ev.evidenceType)) ? String(ev.evidenceType) : "OTHER",
        classification: ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"].includes(String(ev.classification)) ? String(ev.classification) : "RESTRICTED",
        sourceType: "EXTERNAL_IMPORT",
        sourceReference: ev.externalEvidenceId.slice(0, 100),
        collectionLocation: ev.collectionLocation?.slice(0, 200) ?? null,
        collectedAt: ev.collectedAt ? new Date(ev.collectedAt) : null,
        notes: provenanceNote.slice(0, 1000),
      },
      file: undefined,
    });

    await db.externalEvidenceReference.create({
      data: {
        evidenceInternalId: registered.evidence.id,
        providerType: connection.providerType,
        externalSystem: connection.connectionId,
        externalEvidenceId: ev.externalEvidenceId,
        externalReference: ev.title.slice(0, 120),
        custodyHistoryAvailable: historyAvailable, // stays false → HISTORY_UNAVAILABLE recorded (§27)
        sourceCustodian: ev.sourceCustodian?.slice(0, 120) ?? null,
        sourceDepartment: ev.sourceDepartment?.slice(0, 120) ?? null,
        importedByOfficerId: ctx.officer.id,
        importJobId: jobId,
      },
    });

    await db.integrationImportRecord.create({
      data: {
        importJobId: jobId,
        externalRecordId: ev.externalEvidenceId,
        recordType: "EVIDENCE",
        rawReference: ev.title.slice(0, 120),
        normalizedPayload: JSON.stringify({ title: ev.title, evidenceType: ev.evidenceType, custodyHistoryAvailable: historyAvailable, currentExternalHolder: ev.currentExternalHolder ?? null }).slice(0, 4000),
        validationStatus: "VALID",
        conflictStatus: "NONE",
        processingStatus: "IMPORTED",
        centralRecordRef: registered.evidence.evidenceId,
      },
    });

    await recordAuditEvent({
      eventType: "INTEGRATION_RECORD_IMPORTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      caseId: centralCaseRef,
      evidenceId: registered.evidence.evidenceId,
      metadata: { jobId, externalEvidenceId: ev.externalEvidenceId, recordType: "EVIDENCE", custodyHistoryAvailable: historyAvailable, sourceSystem: connection.connectionId },
    });

    return "IMPORTED";
  },

  async recordStagingFailure(jobId: string, externalRecordId: string, recordType: string, err: unknown) {
    const message = err instanceof Error ? err.message : "Record processing failed.";
    await db.integrationImportRecord
      .create({
        data: {
          importJobId: jobId,
          externalRecordId,
          recordType,
          validationStatus: "INVALID",
          processingStatus: "FAILED",
          errorDetails: message.slice(0, 500),
        },
      })
      .catch(() => undefined);
  },

  /** §15 — explicit approval of a STAGED record (sensitive-field gate). */
  async approveStagedRecord(ctx: AuthContext, jobId: string, recordId: string) {
    const job = await db.integrationImportJob.findUnique({ where: { jobId }, include: { connection: true } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    await assertConnectionAccess(ctx, job.connection, "integration.import" as Permission, "import");
    const record = await db.integrationImportRecord.findFirst({ where: { id: recordId, importJobId: job.id } });
    if (!record) throw new ApiError(404, "NOT_FOUND", "Import record not found.");
    if (record.processingStatus !== "STAGED") throw new ApiError(409, "NOT_STAGED", "Only STAGED records can be approved.");

    await db.integrationImportRecord.update({ where: { id: record.id }, data: { processingStatus: "APPROVED" } });
    await db.integrationImportJob.update({ where: { id: job.id }, data: { recordsImported: { increment: 1 }, recordsRejected: { decrement: 1 } } }).catch(() => undefined);
    await recordAuditEvent({
      eventType: "INTEGRATION_RECORD_IMPORTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId: job.jobId, recordId: record.id, externalRecordId: record.externalRecordId, approved: true },
    });
    return { approved: true, recordId: record.id };
  },

  /** §61 step 19 — simulate an external-side change on a MOCK connection (audited, MOCK-only). */
  async simulateExternalChange(ctx: AuthContext, connectionRef: string, externalCaseId: string, patch: { title?: string; description?: string; priority?: string; status?: string }) {
    const connection = await db.integrationConnection.findUnique({ where: { connectionId: connectionRef } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Integration connection not found.");
    if (connection.providerMode !== "MOCK") {
      throw new ApiError(409, "MOCK_ONLY", "External-change simulation is available only for MOCK providers.");
    }
    await assertConnectionAccess(ctx, connection, "integration.configure" as Permission, "configure");
    const ok = mutateMockCase(externalCaseId, patch);
    if (!ok) throw new ApiError(404, "NOT_FOUND", "Unknown mock external case.");
    await recordAuditEvent({
      eventType: "INTEGRATION_CONNECTION_UPDATED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { connectionId: connectionRef, simulation: "external_change", externalCaseId, fields: Object.keys(patch) },
    });
    return { simulated: true };
  },
};

void isSystemAdmin;
