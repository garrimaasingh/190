import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { resolveCaseAccess } from "@/lib/cases/access";
import { canViewDocument } from "@/lib/documents/authorization";
import { canViewEvidence } from "@/lib/evidence/authorization";
import { DocumentStorage, buildInteropPackageKey } from "@/lib/documents/storage";
import { packageEncryptionService } from "./encryption";
import { packageSignatureService } from "./signature";
import { buildPackage, type PackageDraft, type CasePayload, type DocumentPayload, type EvidencePayload, type RelationshipPayload, type AuditExportRecord } from "./package-format";
import { generatePackageId, generateManualExportJobId } from "./ids";
import {
  INTEROP_LIMITS,
  INTEROP_PACKAGE_TTL_HOURS,
  maxClassification,
  PACKAGE_TYPES,
  type PackageType,
} from "./constants";

// ============================================================
// Phase 9 — Manual EXPORT pipeline (§16-§22).
//
//   USER → AUTHENTICATION → CASE AUTHORIZATION → EXPORT PERMISSION
//        → SELECT RECORDS → VALIDATE SELECTION → EXPORT JOB
//        → COLLECT AUTHORIZED DATA → HASH FILES → MANIFEST
//        → PACKAGE → (OPTIONAL SIGN) → TEMPORARY SECURE STORAGE
//        → CONTROLLED DOWNLOAD → AUDIT → EXPIRATION + CLEANUP
//
// Invariants:
// - Never exports objects the officer cannot VIEW (§18). Explicitly
//   selected but unauthorized objects FAIL the job with a generic
//   error — no cross-case identifier leaks.
// - Clearance-filtered objects are EXCLUDED with a reason code only
//   (id + EXCLUDED_CLEARANCE) — metadata beyond the id never leaks.
// - Original binaries are exported UNCHANGED (§9) — packaging never
//   watermarks or otherwise mutates authoritative bytes.
// - Audit export (§12) is opt-in and derives READ-ONLY records; the
//   central ledger remains the only authoritative audit.
// - Package classification = max of included records (§48).
// - Manual package ≠ live integration — job/labels say so.
// ============================================================

export interface ExportSelectionInput {
  caseRef: string;
  packageType: PackageType;
  purpose?: string | null;
  documentIds?: string[] | null; // null/absent + FULL_CASE_EXPORT → all viewable
  evidenceIds?: string[] | null;
  includeRelationships?: boolean;
  includeAuditEvents?: boolean;
}

function publicJob(job: {
  jobId: string; packageId: string | null; exportType: string; status: string; classification: string | null;
  recordCounts: string | null; errorCode: string | null; errorMessage: string | null; expiresAt: Date | null;
  packageSize: number | null; packageSha256: string | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}) {
  return {
    ...job,
    recordCounts: job.recordCounts ? JSON.parse(job.recordCounts) : null,
    interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
  };
}

export const interopExportService = {
  /** Preview the authorized export scope BEFORE building (§56 step 4/6). */
  async preview(ctx: AuthContext, caseRef: string) {
    const caseAndAccess = await this.authorizeCase(ctx, caseRef);
    const access = caseAndAccess.access;
    const [documents, evidence, relationships] = await Promise.all([
      db.caseDocument.findMany({
        where: { caseId: caseAndAccess.id, status: { not: "SUPERSEDED" } },
        select: { documentId: true, title: true, documentType: true, classification: true, status: true, fileSize: true, mimeType: true, sha256Hash: true, committedAt: true },
        orderBy: { committedAt: "asc" },
      }),
      db.evidence.findMany({
        where: { caseId: caseAndAccess.id },
        select: { evidenceId: true, title: true, evidenceType: true, classification: true, status: true, currentCustodianDepartmentId: true, sha256Hash: true, storageKey: true, originalFilename: true, mimeType: true },
        orderBy: { collectedAt: "asc" },
      }),
      db.documentRelationship.findMany({
        where: { OR: [{ sourceDocument: { caseId: caseAndAccess.id } }, { targetDocument: { caseId: caseAndAccess.id } }] },
        select: { id: true, sourceDocumentId: true, targetDocumentId: true, relationshipType: true },
      }),
    ]);

    const documentScope = documents.map((d) => ({
      ...d,
      selectable: canViewDocument(ctx, access, d.classification, d.status),
    }));
    const evidenceScope = evidence.map((e) => ({
      evidenceId: e.evidenceId,
      title: e.title,
      evidenceType: e.evidenceType,
      classification: e.classification,
      status: e.status,
      hasBinary: !!e.storageKey,
      selectable: canViewEvidence(ctx, access, e.classification, e.currentCustodianDepartmentId),
    }));
    const viewableDocIds = new Set(documentScope.filter((d) => d.selectable).map((d) => d.documentId));
    const relationshipScope = relationships.map((r) => ({
      ...r,
      selectable: viewableDocIds.has(r.sourceDocumentId) && viewableDocIds.has(r.targetDocumentId),
    }));

    return {
      caseId: caseAndAccess.caseId,
      title: caseAndAccess.title,
      documents: documentScope,
      evidence: evidenceScope,
      relationships: relationshipScope,
      auditEventsAvailable: true,
      interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
    };
  },

  async authorizeCase(ctx: AuthContext, caseRef: string) {
    const { caseRow, access } = await resolveCaseAccess(ctx, caseRef);
    if (!access.view) {
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_FAILED",
        actorOfficerId: ctx.officer.id,
        caseId: caseRef,
        result: "DENIED",
        metadata: { reason: "CASE_ACCESS_DENIED" },
      });
      // generic 403 — no information about the case beyond the denial
      throw new ApiError(403, "CASE_ACCESS_DENIED", "You are not authorized to export this case.");
    }
    // loadCaseForAccess does not include geography — fetch it for the case payload.
    const geo = await db.case.findUnique({
      where: { id: caseRow.id },
      select: { city: { select: { name: true, district: { select: { name: true, state: { select: { name: true } } } } } } },
    });
    return { ...caseRow, geo, access };
  },

  /** Create + run the export job synchronously (single-node execution; job rows keep a future worker compatible). */
  async runExport(ctx: AuthContext, input: ExportSelectionInput) {
    if (!PACKAGE_TYPES.includes(input.packageType)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Unsupported package type.");
    }
    if (input.packageType.endsWith("_IMPORT")) {
      throw new ApiError(422, "VALIDATION_ERROR", "EXPORT package types only.");
    }
    const jobId = await generateManualExportJobId();

    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_REQUESTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, packageType: input.packageType, purpose: input.purpose?.slice(0, 200) ?? null },
    });

    const job = await db.manualExportJob.create({
      data: {
        jobId,
        requestedByOfficerId: ctx.officer.id,
        requestedByDepartmentId: ctx.officer.departmentId,
        exportType: input.packageType,
        status: "PROCESSING",
        startedAt: new Date(),
        selection: JSON.stringify({
          caseRef: input.caseRef,
          documentIds: input.documentIds ?? null,
          evidenceIds: input.evidenceIds ?? null,
          includeRelationships: input.includeRelationships !== false,
          includeAuditEvents: input.includeAuditEvents === true,
          purpose: input.purpose?.slice(0, 500) ?? null,
        }),
      },
    });
    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_STARTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, packageType: input.packageType },
    });

    try {
      const result = await this.buildAndStore(ctx, job.id, jobId, input);
      const finished = await db.manualExportJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          packageId: result.packageId,
          packageStorageKey: result.storageKey,
          packageKeyReference: result.keyReference,
          packageSize: result.packageSize,
          packageSha256: result.rawArchiveSha256,
          expiresAt: result.expiresAt,
          classification: result.classification,
          recordCounts: JSON.stringify(result.counts),
        },
      });
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_COMPLETED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        caseId: input.caseRef,
        metadata: { jobId, packageId: result.packageId, counts: result.counts, expiresAt: result.expiresAt.toISOString() },
      });
      return { job: publicJob(finished), packageId: result.packageId };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Export failed.";
      const code = err instanceof ApiError ? err.code : "EXPORT_FAILED";
      await db.manualExportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", completedAt: new Date(), errorCode: code, errorMessage: message.slice(0, 300) },
      });
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_FAILED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        caseId: input.caseRef,
        result: "FAILED",
        metadata: { jobId, errorCode: code },
      });
      throw err;
    }
  },

  async buildAndStore(ctx: AuthContext, jobInternalId: string, jobId: string, input: ExportSelectionInput) {
    const caseRow = await this.authorizeCase(ctx, input.caseRef);
    const access = caseRow.access;

    // ---- collect documents (§9) with clearance filtering (§18) ----
    const wantsAllDocs = !input.documentIds || input.documentIds.length === 0;
    if (!wantsAllDocs && input.packageType === "FULL_CASE_EXPORT") {
      throw new ApiError(422, "VALIDATION_ERROR", "FULL_CASE_EXPORT always includes every authorized record — choose CASE_EXPORT for a selection.");
    }
    const explicitDocIds = wantsAllDocs ? null : [...new Set(input.documentIds!)];
    if (explicitDocIds && explicitDocIds.length > INTEROP_LIMITS.MAX_EXPORT_DOCUMENTS) {
      throw new ApiError(422, "EXPORT_TOO_LARGE", `Selection exceeds ${INTEROP_LIMITS.MAX_EXPORT_DOCUMENTS} documents.`);
    }
    const docs = await db.caseDocument.findMany({
      where: { caseId: caseRow.id, ...(explicitDocIds ? { documentId: { in: explicitDocIds } } : {}), status: { not: "SUPERSEDED" } },
      include: { uploadedByOfficer: { select: { officerId: true, name: true } }, uploadedByDepartment: { select: { name: true } } },
    });
    if (explicitDocIds) {
      const found = new Set(docs.map((d) => d.documentId));
      const missing = explicitDocIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        // §18: fail without echoing which foreign-case objects matched.
        throw new ApiError(422, "EXPORT_SELECTION_UNAUTHORIZED", "One or more selected records are not authorized for export from this case.");
      }
    }

    const documentPayloads: { payload: DocumentPayload; binary?: Buffer }[] = [];
    const excluded: { id: string; reason: string }[] = [];
    const includedClassifications: string[] = [];
    for (const doc of docs) {
      if (!canViewDocument(ctx, access, doc.classification, doc.status)) {
        excluded.push({ id: doc.documentId, reason: "EXCLUDED_CLEARANCE" });
        continue;
      }
      let binary: Buffer | undefined;
      if (doc.storageKey && doc.status === "COMMITTED") {
        const stored = await DocumentStorage.get_object(doc.storageKey);
        // Decrypt-at-rest store holds ENC1 blobs; document bytes are decrypted
        // via the same Phase 3 path used by the authorized viewer.
        const { decryptDocument } = await import("@/lib/documents/encryption");
        binary = decryptDocument(stored);
        if (binary.length !== doc.fileSize) {
          throw new ApiError(500, "INTERNAL_ERROR", `Stored object size mismatch for ${doc.documentId}.`);
        }
      }
      const payload: DocumentPayload = {
        document_id: doc.documentId,
        case_id: caseRow.caseId,
        title: doc.title,
        description: doc.description?.slice(0, 2000) ?? null,
        document_type: doc.documentType,
        document_category: doc.documentCategory ?? null,
        classification: doc.classification,
        original_filename: doc.originalFilename,
        mime_type: doc.mimeType,
        size: doc.fileSize,
        sha256: doc.sha256Hash,
        committed_at: doc.committedAt?.toISOString() ?? null,
        document_date: doc.documentDate?.toISOString() ?? null,
        source_department: doc.uploadedByDepartment.name,
        uploaded_by: doc.uploadedByOfficer.name,
        has_binary: !!binary,
        binary_path: null,
      };
      includedClassifications.push(doc.classification);
      documentPayloads.push({ payload, binary });
    }

    // ---- collect evidence (§10/§11) ----
    const explicitEvdIds = !input.evidenceIds || input.evidenceIds.length === 0 ? null : [...new Set(input.evidenceIds)];
    if (explicitEvdIds && explicitEvdIds.length > INTEROP_LIMITS.MAX_EXPORT_EVIDENCE) {
      throw new ApiError(422, "EXPORT_TOO_LARGE", `Selection exceeds ${INTEROP_LIMITS.MAX_EXPORT_EVIDENCE} evidence records.`);
    }
    const evidenceRows = await db.evidence.findMany({
      where: { caseId: caseRow.id, ...(explicitEvdIds ? { evidenceId: { in: explicitEvdIds } } : {}) },
      include: {
        collectingDepartment: { select: { name: true } },
        currentCustodianDepartment: { select: { name: true } },
        currentCustodianOfficer: { select: { officerId: true, name: true } },
        collectedByOfficer: { select: { officerId: true, name: true } },
        transfers: { select: { transferId: true, status: true, reason: true, createdAt: true, requestedByOfficer: { select: { name: true } }, fromDepartment: { select: { name: true } }, toDepartment: { select: { name: true } }, toOfficer: { select: { name: true } }, acceptedAt: true } },
      },
    });
    if (explicitEvdIds) {
      const found = new Set(evidenceRows.map((e) => e.evidenceId));
      const missing = explicitEvdIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new ApiError(422, "EXPORT_SELECTION_UNAUTHORIZED", "One or more selected records are not authorized for export from this case.");
      }
    }

    const evidencePayloads: { payload: EvidencePayload; binary?: Buffer }[] = [];
    for (const ev of evidenceRows) {
      if (!canViewEvidence(ctx, access, ev.classification, ev.currentCustodianDepartmentId)) {
        excluded.push({ id: ev.evidenceId, reason: "EXCLUDED_CLEARANCE" });
        continue;
      }
      // §11 — chain of custody: export what the actor is authorized to see;
      // NEVER invent events. Custody history is derived from transfer rows.
      const transfers = [...ev.transfers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const custodyTrail = transfers.map((t) => ({
        transfer_id: t.transferId,
        from_department: t.fromDepartment.name,
        to_department: t.toDepartment.name,
        requesting_officer: t.requestedByOfficer.name,
        accepting_officer: t.toOfficer?.name ?? null,
        timestamp: t.createdAt.toISOString(),
        reason: t.reason?.slice(0, 500) ?? null,
        status: t.status,
      }));

      let binary: Buffer | undefined;
      if (ev.storageKey && ev.sha256Hash) {
        const { decryptDocument } = await import("@/lib/documents/encryption");
        binary = decryptDocument(await DocumentStorage.get_object(ev.storageKey));
      }
      const payload: EvidencePayload = {
        evidence_id: ev.evidenceId,
        case_id: caseRow.caseId,
        title: ev.title,
        description: ev.description?.slice(0, 2000) ?? null,
        evidence_type: ev.evidenceType,
        category: ev.category ?? null,
        classification: ev.classification,
        status: ev.status,
        source_type: ev.sourceType,
        collection_location: ev.collectionLocation ?? null,
        collected_at: ev.collectedAt?.toISOString() ?? null,
        custodian_department: ev.currentCustodianDepartment?.name ?? null,
        custodian_officer: ev.currentCustodianOfficer?.name ?? null,
        sha256: ev.sha256Hash ?? null,
        has_binary: !!binary,
        binary_path: null,
        custody_history_available: transfers.length > 0,
        custody_trail: custodyTrail,
        external_references: ev.evidenceNumber ? [ev.evidenceNumber] : null,
      };
      includedClassifications.push(ev.classification);
      evidencePayloads.push({ payload, binary });
    }

    // ---- relationships (only between INCLUDED documents) ----
    const includedDocIds = new Set(documentPayloads.map((d) => d.payload.document_id));
    const relationships: RelationshipPayload[] = [];
    if (input.includeRelationships !== false) {
      const relRows = await db.documentRelationship.findMany({
        where: { OR: [{ sourceDocument: { caseId: caseRow.id } }, { targetDocument: { caseId: caseRow.id } }] },
        include: { createdByOfficer: { select: { officerId: true, name: true } } },
      });
      for (const r of relRows) {
        if (includedDocIds.has(r.sourceDocumentId) && includedDocIds.has(r.targetDocumentId)) {
          relationships.push({
            relationship_id: r.id,
            source_type: "DOCUMENT",
            source_id: r.sourceDocumentId,
            target_type: "DOCUMENT",
            target_id: r.targetDocumentId,
            relationship_type: r.relationshipType,
            provenance: "AUTHORITATIVE_IMPORT",
            created_by: r.createdByOfficer.name,
            created_at: r.createdAt.toISOString(),
          });
        } else {
          // §18: relationship touching an excluded object → omitted, never exported unauthorized.
          excluded.push({ id: r.id, reason: "RELATIONSHIP_OMITTED_UNAUTHORIZED_ENDPOINT" });
        }
      }
    }

    // ---- optional derived audit export (§12) ----
    let auditEvents: AuditExportRecord[] | undefined;
    if (input.includeAuditEvents === true) {
      const auditRows = await db.auditEvent.findMany({
        where: { OR: [{ caseId: caseRow.caseId }, { documentId: { in: [...includedDocIds] } }, { evidenceId: { in: evidencePayloads.map((e) => e.payload.evidence_id) } }] },
        select: { eventId: true, eventType: true, actorOfficerId: true, actorDepartmentId: true, caseId: true, documentId: true, evidenceId: true, timestamp: true, result: true, eventHash: true, previousEventHash: true, sequence: true },
        orderBy: { sequence: "asc" as const },
        take: 1000,
      });
      auditEvents = auditRows.map((a) => ({
        event_id: a.eventId,
        event_type: a.eventType,
        actor: a.actorOfficerId,
        department: a.actorDepartmentId,
        case_id: a.caseId,
        document_id: a.documentId,
        evidence_id: a.evidenceId,
        timestamp: a.timestamp.toISOString(),
        result: a.result,
        event_hash: a.eventHash,
        previous_event_hash: a.previousEventHash,
        ledger_status: "DERIVED_COPY",
      }));
    }

    // ---- case payload (§8) ----
    const participating = await db.caseDepartment.findMany({
      where: { caseId: caseRow.id, status: "ACTIVE" },
      include: { department: { select: { name: true } } },
    });
    const officers = await db.caseOfficer.findMany({
      where: { caseId: caseRow.id, status: "ACTIVE" },
      include: { officer: { select: { officerId: true, name: true } } },
    });
    const casePayload: CasePayload = {
      case_id: caseRow.caseId,
      official_case_number: caseRow.caseNumber ?? null,
      title: caseRow.title,
      description: caseRow.description,
      case_type: caseRow.caseType,
      case_category: caseRow.caseCategory ?? null,
      priority: caseRow.priority,
      status: caseRow.status,
      geography: {
        country: "India",
        state: caseRow.geo?.city.district.state.name ?? null,
        district: caseRow.geo?.city.district.name ?? null,
        city: caseRow.geo?.city.name ?? null,
      },
      originating_department: participating.find((p) => p.participationType === "ORIGINATING")?.department.name ?? null,
      participating_departments: participating.map((p) => p.department.name),
      authorized_case_officers: officers.map((o) => `${o.officer.name} (${o.officer.officerId})`),
      opened_at: (caseRow.openedAt ?? caseRow.createdAt).toISOString(),
      created_at: caseRow.createdAt.toISOString(),
      external_references: caseRow.caseNumber ? [caseRow.caseNumber] : null,
    };

    // ---- package identity + build (§4/§5/§13/§14) ----
    const packageId = await generatePackageId();
    const draft: PackageDraft = {
      manifest: {
        package_id: packageId,
        package_type: input.packageType,
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        created_by: `${ctx.officer.name} (${ctx.officer.officerId})`,
        source_system: "Central Case Platform",
        source_department: ctx.officer.departmentId,
        source_environment: process.env.NODE_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT",
        case_count: 1,
        document_count: documentPayloads.length,
        evidence_count: evidencePayloads.length,
        relationship_count: relationships.length,
        integrity_algorithm: "SHA-256",
        integrity_manifest_reference: "integrity.json",
      },
      metadata: {
        case_reference: caseRow.caseId,
        export_purpose: input.purpose?.slice(0, 500) ?? null,
        target_system: null,
        export_officer: `${ctx.officer.name} (${ctx.officer.officerId})`,
        export_department: ctx.officer.departmentId,
        created_at: new Date().toISOString(),
        schema_version: "1.0",
        classification: null,
        record_counts: {
          cases: 1,
          documents: documentPayloads.length,
          evidence: evidencePayloads.length,
          relationships: relationships.length,
          audit_events: auditEvents?.length ?? 0,
        },
      },
      case: casePayload,
      documents: documentPayloads,
      evidence: evidencePayloads,
      relationships,
      auditEvents,
    };

    const built = buildPackage(draft);

    // ---- package classification (§48): max of included records, never lower ----
    const classification = maxClassification([
      ...includedClassifications,
      ...(auditEvents && auditEvents.length > 0 ? ["RESTRICTED"] : []),
    ]);

    const signature = await packageSignatureService.sign(built.zip, { packageId, signerOfficerId: ctx.officer.officerId });

    // ---- temporary secure storage (§20): encrypted at rest, TTL-bound ----
    const { payload: encrypted, keyReference } = await packageEncryptionService.encryptPackage(built.zip);
    const storageKey = buildInteropPackageKey(jobId);
    await DocumentStorage.put_object(storageKey, encrypted);
    const expiresAt = new Date(Date.now() + INTEROP_PACKAGE_TTL_HOURS * 3600 * 1000);

    // ---- package records (§81) ----
    await db.packageRecord.create({
      data: {
        packageId,
        packageType: input.packageType,
        schemaVersion: "1.0",
        sourceSystem: "Central Case Platform",
        sourceDepartment: ctx.officer.departmentId,
        sourceApplication: "Central Case Platform",
        sourceVersion: null,
        createdInEnvironment: process.env.NODE_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT",
        classification,
        caseCount: 1,
        documentCount: documentPayloads.length,
        evidenceCount: evidencePayloads.length,
        relationshipCount: relationships.length,
        integrityAlgorithm: "SHA-256",
        packageIntegrity: built.integrityCanonicalSha256,
        packageSha256: built.rawArchiveSha256,
        manifestHash: built.integrityCanonicalSha256,
        firstSeenJobId: jobId,
        files: {
          create: built.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
        },
        integrityChecks: {
          create: {
            jobId,
            kind: "EXPORT_BUILD",
            algorithm: "SHA-256",
            result: "MATCH",
            expectedSha256: built.rawArchiveSha256,
            actualSha256: built.rawArchiveSha256,
            verifiedByOfficerId: ctx.officer.id,
          },
        },
        signatures: {
          create: {
            algorithm: signature.algorithm,
            status: signature.status,
            note: signature.note,
          },
        },
      },
    });

    const counts = {
      cases: 1,
      documents: documentPayloads.length,
      evidence: evidencePayloads.length,
      relationships: relationships.length,
      auditEvents: auditEvents?.length ?? 0,
      excluded: excluded.length,
    };

    return {
      packageId,
      storageKey,
      keyReference,
      packageSize: built.zip.length,
      rawArchiveSha256: built.rawArchiveSha256,
      expiresAt,
      classification,
      counts,
      excluded,
    };
  },

  /** Controlled download (§21/§52/§75): auth → ownership/scope → status → expiry. */
  async download(ctx: AuthContext, jobId: string) {
    const job = await db.manualExportJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");

    const isOwner = job.requestedByOfficerId === ctx.officer.id;
    const isSameDepartment = job.requestedByDepartmentId === ctx.officer.departmentId;
    const isSysAdmin = ctx.officer.role === "SYSTEM_ADMIN";
    if (!isOwner && !isSameDepartment && !isSysAdmin) {
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_DOWNLOADED",
        actorOfficerId: ctx.officer.id,
        result: "DENIED",
        metadata: { jobId, reason: "NOT_AUTHORIZED_FOR_DOWNLOAD" },
      });
      throw new ApiError(403, "DOWNLOAD_NOT_AUTHORIZED", "You are not authorized to download this package.");
    }
    if (job.status === "EXPIRED" || (job.expiresAt && job.expiresAt.getTime() < Date.now())) {
      if (job.status === "COMPLETED") {
        await this.expireJob(job.id, job.jobId);
      }
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_EXPIRED",
        actorOfficerId: ctx.officer.id,
        result: "DENIED",
        metadata: { jobId, reason: "PACKAGE_EXPIRED" },
      });
      throw new ApiError(410, "PACKAGE_EXPIRED", "This export package has expired and is no longer available.");
    }
    if (job.status !== "COMPLETED" || !job.packageStorageKey || !job.packageId) {
      throw new ApiError(409, "PACKAGE_NOT_AVAILABLE", `Export job is ${job.status}; no package is available.`);
    }

    const record = await db.packageRecord.findUnique({ where: { packageId: job.packageId } });
    if (!record) throw new ApiError(500, "PACKAGE_RECORD_MISSING", "Package metadata record is missing — download refused.");
    const encrypted = await DocumentStorage.get_object(job.packageStorageKey);
    const zip = await packageEncryptionService.decryptPackage(encrypted, job.packageKeyReference);

    // integrity re-check at download time (tampered-at-rest detection)
    const actualSha = (await import("crypto")).createHash("sha256").update(zip).digest("hex");
    if (record && actualSha !== record.packageSha256) {
      await recordAuditEvent({
        eventType: "MANUAL_EXPORT_FAILED",
        actorOfficerId: ctx.officer.id,
        result: "FAILED",
        metadata: { jobId, reason: "PACKAGE_AT_REST_TAMPERED" },
      });
      throw new ApiError(500, "PACKAGE_INTEGRITY_FAILED", "Stored package failed an integrity re-check — download refused.");
    }

    await db.packageDownload.create({
      data: {
        packageId: record!.id, // internal cuid — the FK points at PackageRecord.id
        exportJobId: jobId,
        downloadedByOfficerId: ctx.officer.id,
        downloadedByDepartmentId: ctx.officer.departmentId,
      },
    });
    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_DOWNLOADED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      result: "SUCCESS",
      metadata: { jobId, packageId: job.packageId, packageSha256: actualSha.slice(0, 16) },
    });

    return {
      zip,
      filename: `${job.packageId}.zip`,
      packageId: job.packageId,
      sha256: actualSha,
    };
  },

  async cancel(ctx: AuthContext, jobId: string) {
    const job = await db.manualExportJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");
    const isOwner = job.requestedByOfficerId === ctx.officer.id;
    if (!isOwner && ctx.officer.role !== "SYSTEM_ADMIN") {
      throw new ApiError(403, "CANCEL_NOT_AUTHORIZED", "Only the requesting officer or a system administrator can cancel an export.");
    }
    if (!["QUEUED", "PROCESSING"].includes(job.status)) {
      throw new ApiError(409, "CANCEL_NOT_ALLOWED", `Export job is ${job.status}; only QUEUED/PROCESSING jobs can be cancelled.`);
    }
    const updated = await db.manualExportJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", completedAt: new Date(), errorCode: "CANCELLED_BY_USER", errorMessage: "Cancelled by the requesting officer." },
    });
    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_CANCELLED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      metadata: { jobId },
    });
    return publicJob(updated);
  },

  /** Expiration transition + file deletion (§53/§54). Audit rows retained. */
  async expireJob(internalId: string, jobId: string): Promise<void> {
    const job = await db.manualExportJob.findUnique({ where: { id: internalId } });
    if (!job || job.status === "EXPIRED") return;
    if (job.packageStorageKey) DocumentStorage.delete_staged_object(job.packageStorageKey);
    await db.manualExportJob.update({
      where: { id: internalId },
      data: { status: "EXPIRED", completedAt: job.completedAt ?? new Date(), errorCode: "PACKAGE_EXPIRED", errorMessage: "Package expired; temporary storage deleted." },
    });
    await recordAuditEvent({
      eventType: "MANUAL_EXPORT_EXPIRED",
      metadata: { jobId, reason: "TTL_REACHED" },
    });
  },

  /** Background-style cleanup sweep (§54) — lazy trigger + explicit admin endpoint. */
  async sweepExpired(): Promise<{ expired: number }> {
    const due = await db.manualExportJob.findMany({
      where: { status: "COMPLETED", expiresAt: { lt: new Date() } },
      select: { id: true, jobId: true },
    });
    for (const job of due) {
      await this.expireJob(job.id, job.jobId);
    }
    return { expired: due.length };
  },

  async listJobs(ctx: AuthContext) {
    // §54: lazy sweep keeps "Expired Packages" truthful without a cron.
    await this.sweepExpired();
    const where = ctx.officer.role === "SYSTEM_ADMIN" ? {} : { requestedByDepartmentId: ctx.officer.departmentId };
    const jobs = await db.manualExportJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        jobId: true, packageId: true, exportType: true, status: true, classification: true,
        recordCounts: true, errorCode: true, errorMessage: true, expiresAt: true,
        packageSize: true, packageSha256: true, startedAt: true, completedAt: true, createdAt: true,
        requestedByOfficer: { select: { officerId: true, name: true } },
      },
    });
    return jobs.map((j) => ({
      ...j,
      requestedBy: j.requestedByOfficer,
      requestedByOfficer: undefined,
      recordCounts: j.recordCounts ? JSON.parse(j.recordCounts) : null,
    }));
  },
};
