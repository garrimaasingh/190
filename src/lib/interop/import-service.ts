import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit/service";
import { resolveCaseAccess } from "@/lib/cases/access";
import { uploadAndCommit } from "@/lib/documents/service";
import { registerEvidence } from "@/lib/evidence/service";
import { autoEnqueueAfterCommit } from "@/lib/ai/jobs";
import { DocumentStorage, buildInteropPackageKey } from "@/lib/documents/storage";
import { packageEncryptionService } from "./encryption";
import { packageSignatureService } from "./signature";
import { parsePackage, canonicalSha256, ZipFormatError, type ParsedPackage, type CasePayload } from "./package-format";
import { generatePackageId, generateManualImportJobId, generateManualConflictId } from "./ids";
import {
  INTEROP_IMPORT_APPROVAL_POLICY,
  INTEROP_SEPARATION_OF_DUTIES,
  INTEROP_CASE_MUTABLE_FIELDS,
  maxClassification,
  classificationLevel,
  PACKAGE_CLASSIFICATIONS,
  type PackageType,
} from "./constants";
import type { ConflictResolution } from "./conflict-policy";

// ============================================================
// Phase 9 — Manual IMPORT pipeline (§23-§47, §51).
//
//   UPLOAD → ARCHIVE SECURITY → SCHEMA VALIDATION → INTEGRITY
//   VERIFICATION → (SIGNATURE STATUS) → FILE SECURITY SCAN →
//   STAGING → REFERENCE RESOLUTION → CONFLICT DETECTION →
//   IMPORT REVIEW → APPROVAL → CENTRAL IMPORT → HASH
//   VERIFICATION → AUDIT → CLEANUP
//
// Invariants:
// - Uploaded archives are NEVER unpacked into the application root;
//   they are analyzed in-memory from an encrypted staging blob (§25).
// - The central system's IDs stay authoritative: external IDs live in
//   Phase 8 External*Reference rows (providerType MANUAL_PACKAGE) (§31).
// - Imported documents flow through the REAL Phase 3 pipeline and are
//   immutable once committed — no special imported-document behavior (§32/§33).
// - Evidence custody is NEVER written by an import (§34/§72); transfer
//   claims become provenance notes; the custody workflow stays authoritative.
// - Incoming classification can never DOWNGRADE a central record (§41/§73).
// - Immutable central fields (hash/binary/IDs) generate conflicts, never
//   overwrites (§37/§38).
// - Partial results are reported honestly (§45): PARTIAL ≠ SUCCESS.
// - Identity is session-derived: forged uploaded_by fields are ignored (§74).
// ============================================================

const PROVIDER_TYPE = "MANUAL_PACKAGE";

export interface ImportUploadMeta {
  purpose?: string | null;
}

function jobErr(code: string, message: string) {
  return { errorCode: code, errorMessage: message };
}

export const interopImportService = {
  // ------------------------------------------------------------
  // STEP 7 — upload (§23/§24/§43/§70)
  // ------------------------------------------------------------
  async upload(ctx: AuthContext, archive: Buffer, meta: ImportUploadMeta) {
    const jobId = await generateManualImportJobId();

    // Duplicate package detection BEFORE any parsing work (§43/§70).
    const { sha256Hex } = await import("./zip");
    const rawSha = sha256Hex(archive);
    const existing = await db.packageRecord.findUnique({ where: { packageSha256: rawSha } });
    if (existing) {
      const job = await db.manualImportJob.create({
        data: {
          jobId,
          uploadedByOfficerId: ctx.officer.id,
          uploadedByDepartmentId: ctx.officer.departmentId,
          status: "FAILED",
          packageId: existing.packageId,
          packageSha256: rawSha,
          stage: "DUPLICATE_CHECK",
          ...jobErr("DUPLICATE_PACKAGE", "An identical package (same SHA-256) was already processed — duplicate import refused."),
          completedAt: new Date(),
        },
      });
      await recordAuditEvent({
        eventType: "MANUAL_IMPORT_DUPLICATE",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "DENIED",
        metadata: { jobId, packageId: existing.packageId, packageSha256: rawSha.slice(0, 16) },
      });
      return job;
    }

    // Staging blob: encrypted at rest under the interop-packages namespace.
    const { payload: encrypted, keyReference } = await packageEncryptionService.encryptPackage(archive);
    const storageKey = buildInteropPackageKey(jobId);
    await DocumentStorage.put_object(storageKey, encrypted);

    const job = await db.manualImportJob.create({
      data: {
        jobId,
        uploadedByOfficerId: ctx.officer.id,
        uploadedByDepartmentId: ctx.officer.departmentId,
        status: "UPLOADED",
        stage: "UPLOADED",
        packageStorageKey: storageKey,
        packageKeyReference: keyReference,
        packageSize: archive.length,
        packageSha256: rawSha,
      },
    });
    await recordAuditEvent({
      eventType: "MANUAL_IMPORT_UPLOADED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, sizeBytes: archive.length, purpose: meta.purpose?.slice(0, 200) ?? null },
    });
    return job;
  },

  // ------------------------------------------------------------
  // STEP 8-13 — validate + stage (§23-§30, §36, §41-§44)
  // ------------------------------------------------------------
  async validate(ctx: AuthContext, jobId: string) {
    const job = await db.manualImportJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    if (["IMPORTING", "COMPLETED", "PARTIAL", "REJECTED", "CANCELLED"].includes(job.status)) {
      throw new ApiError(409, "VALIDATE_NOT_ALLOWED", `Import job is ${job.status}; validation is no longer available.`);
    }

    await db.manualImportJob.update({ where: { id: job.id }, data: { status: "VALIDATING", stage: "ARCHIVE_SECURITY", startedAt: job.startedAt ?? new Date() } });
    await recordAuditEvent({
      eventType: "MANUAL_IMPORT_VALIDATION_STARTED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      metadata: { jobId },
    });

    // wipe previous staging state (re-validation after a failed attempt)
    await db.manualImportRecord.deleteMany({ where: { importJobId: job.id } });
    await db.manualImportConflict.deleteMany({ where: { importJobId: job.id } });

    let parsed: ParsedPackage;
    try {
      if (!job.packageStorageKey) throw new ApiError(409, "NO_PACKAGE", "Import job has no staged package.");
      const stored = await DocumentStorage.get_object(job.packageStorageKey);
      const archive = await packageEncryptionService.decryptPackage(stored, job.packageKeyReference);
      // parsePackage enforces: zip security limits, path safety, schema version,
      // per-file integrity vs integrity.json, manifest counts (§25-§27, §3, §13/§14).
      parsed = parsePackage(archive);
    } catch (err) {
      const code = err instanceof ZipFormatError ? err.code : "PACKAGE_INVALID";
      const message = err instanceof Error ? err.message.slice(0, 280) : "Package could not be parsed.";
      await db.manualImportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", stage: "VALIDATION_FAILED", ...jobErr(code, message), completedAt: new Date() },
      });
      await recordAuditEvent({
        eventType: "MANUAL_IMPORT_VALIDATION_FAILED",
        actorOfficerId: ctx.officer.id,
        result: "FAILED",
        metadata: { jobId, errorCode: code },
      });
      throw new ApiError(422, code, message);
    }

    // ---- package identity + duplicates (§43/§44/§70) ----
    await db.manualImportJob.update({ where: { id: job.id }, data: { stage: "PACKAGE_IDENTITY" } });
    let packageRow = await db.packageRecord.findUnique({ where: { packageId: parsed.manifest.package_id } });
    if (packageRow && packageRow.packageSha256 !== parsed.rawArchiveSha256) {
      // Same package ID, different bytes → tampered/forbidden re-use of identity.
      await db.manualImportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", stage: "VALIDATION_FAILED", ...jobErr("PACKAGE_ID_REUSED", "Package ID already exists with different content — refusing to import."), completedAt: new Date() },
      });
      await recordAuditEvent({
        eventType: "MANUAL_IMPORT_VALIDATION_FAILED",
        actorOfficerId: ctx.officer.id,
        result: "FAILED",
        metadata: { jobId, packageId: parsed.manifest.package_id, reason: "PACKAGE_ID_REUSED" },
      });
      throw new ApiError(422, "PACKAGE_ID_REUSED", "Package ID already exists with different content — refusing to import.");
    }
    if (!packageRow) {
      packageRow = await db.packageRecord.create({
        data: {
          packageId: parsed.manifest.package_id,
          packageType: parsed.manifest.package_type,
          schemaVersion: parsed.manifest.schema_version,
          sourceSystem: parsed.manifest.source_system,
          sourceDepartment: parsed.manifest.source_department ?? null,
          sourceApplication: parsed.manifest.source_application ?? null,
          sourceVersion: parsed.manifest.source_version ?? null,
          createdInEnvironment: parsed.manifest.source_environment ?? null,
          classification: maxClassification([
            parsed.metadata.classification ?? "INTERNAL",
            ...parsed.documents.map((d) => d.payload.classification),
            ...parsed.evidence.map((e) => e.payload.classification),
          ]),
          caseCount: parsed.manifest.case_count,
          documentCount: parsed.manifest.document_count,
          evidenceCount: parsed.manifest.evidence_count,
          relationshipCount: parsed.manifest.relationship_count,
          integrityAlgorithm: "SHA-256",
          packageIntegrity: parsed.integrityCanonicalSha256,
          packageSha256: parsed.rawArchiveSha256,
          manifestHash: canonicalSha256(parsed.manifest),
          firstSeenJobId: jobId,
          files: { create: parsed.integrity.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })) },
        },
      });
    }

    // ---- signature status (§15) — honest UNSUPPORTED unless configured ----
    const signatureStatus = await packageSignatureService.verify(parsed.rawArchiveSha256.length ? parsed.entries[0].data : Buffer.alloc(0), { algorithm: "UNSUPPORTED", signaturePayload: "" });

    // ---- security scan gate (§28): binaries already went through magic-byte
    // structure checks inside parsePackage? No — metadata only. Binaries are
    // scanned NOW via the Phase 3 scanner; the commit path re-validates. ----
    await db.manualImportJob.update({ where: { id: job.id }, data: { stage: "SECURITY_SCAN" } });
    const { scanBuffer } = await import("./scan");
    let scanStatus = "CLEAN";
    const binaries = [
      ...parsed.documents.filter((d) => d.binary).map((d) => ({ id: d.payload.document_id, data: d.binary!, name: d.payload.original_filename, mime: d.payload.mime_type })),
      ...parsed.evidence.filter((e) => e.binary).map((e) => ({ id: e.payload.evidence_id, data: e.binary!, name: `evidence-${e.payload.evidence_id}.bin`, mime: "application/octet-stream" })),
    ];
    for (const b of binaries) {
      const verdict = scanBuffer(b.data, b.name, b.mime);
      if (verdict === "MALICIOUS") {
        await db.manualImportJob.update({
          where: { id: job.id },
          data: { status: "FAILED", stage: "SECURITY_SCAN", scanStatus: "MALICIOUS", ...jobErr("MALICIOUS_CONTENT", `Security scan rejected binary ${b.id}.`), completedAt: new Date() },
        });
        await recordAuditEvent({
          eventType: "MANUAL_IMPORT_VALIDATION_FAILED",
          actorOfficerId: ctx.officer.id,
          result: "FAILED",
          metadata: { jobId, reason: "MALICIOUS_CONTENT", binaryId: b.id },
        });
        throw new ApiError(422, "MALICIOUS_CONTENT", `Security scan rejected binary ${b.id} — package refused.`);
      }
      if (verdict === "SUSPICIOUS") scanStatus = "SUSPICIOUS";
    }

    // ---- staging + reference resolution (§29/§30) ----
    await db.manualImportJob.update({ where: { id: job.id }, data: { stage: "REFERENCE_RESOLUTION" } });
    const conflicts: { fieldName: string; recordType: string; recordExternalId: string; centralValue: string | null; incomingValue: string | null; sourceReference: string | null; conflictType: string }[] = [];

    let received = 0;
    let valid = 0;
    let invalid = 0;

    const externalSystem = parsed.manifest.source_system;

    // resolve the package case (if any)
    let centralCaseId: string | null = null;
    let centralCaseInternalId: string | null = null;
    if (parsed.case) {
      received += 1;
      const existingRef = await db.externalCaseReference.findUnique({
        where: { providerType_externalSystem_externalCaseId: { providerType: PROVIDER_TYPE, externalSystem, externalCaseId: parsed.case.payload.case_id } },
        include: { case: { select: { id: true, caseId: true, title: true, description: true } } },
      });
      if (existingRef) {
        centralCaseId = existingRef.case.caseId;
        centralCaseInternalId = existingRef.caseInternalId;
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "CASE",
            externalId: parsed.case.payload.case_id,
            resolution: "LINK_EXISTING",
            targetEntityId: centralCaseId,
            payloadJson: JSON.stringify(parsed.case.payload).slice(0, 8000),
            validationStatus: "VALID",
            conflictStatus: "NONE",
            authorizationStatus: "PENDING",
            processingStatus: "STAGED",
          },
        });
        valid += 1;
        // §36 — authorized-field diffs on the linked case
        for (const field of INTEROP_CASE_MUTABLE_FIELDS) {
          const incoming = (parsed.case.payload as unknown as Record<string, unknown>)[field];
          const central = (existingRef.case as unknown as Record<string, unknown>)[field];
          if (typeof incoming === "string" && typeof central === "string" && incoming.trim() !== central.trim()) {
            conflicts.push({ fieldName: field, recordType: "CASE", recordExternalId: parsed.case.payload.case_id, centralValue: central.slice(0, 300), incomingValue: incoming.slice(0, 300), sourceReference: "case/case.json", conflictType: "FIELD_VALUE" });
          }
        }
      } else {
        // CREATE — validate required fields now (§31)
        const payload = parsed.case.payload;
        if (!payload.title || payload.title.trim().length < 2 || !payload.case_type || !payload.priority) {
          await db.manualImportRecord.create({
            data: {
              importJobId: job.id,
              recordType: "CASE",
              externalId: payload.case_id,
              resolution: "REJECT",
              payloadJson: JSON.stringify(payload).slice(0, 8000),
              validationStatus: "INVALID",
              processingStatus: "REJECTED",
              errorDetails: "Required case fields missing (title/case_type/priority).",
            },
          });
          invalid += 1;
        } else {
          await db.manualImportRecord.create({
            data: {
              importJobId: job.id,
              recordType: "CASE",
              externalId: payload.case_id,
              resolution: "CREATE",
              payloadJson: JSON.stringify(payload).slice(0, 8000),
              validationStatus: "VALID",
              conflictStatus: "NONE",
              authorizationStatus: "PENDING",
              processingStatus: "STAGED",
            },
          });
          valid += 1;
        }
      }
    }

    // documents (§32-§33/§44)
    for (const doc of parsed.documents) {
      received += 1;
      const docCaseExternalId = doc.payload.case_id;
      let targetCaseInternalId = centralCaseInternalId;
      let targetCaseRef = centralCaseId;
      if (parsed.case && docCaseExternalId === parsed.case.payload.case_id) {
        if (!centralCaseInternalId) {
          // The package's own case is being CREATEd in this same job — commit
          // processes CASE records first, so stage the document against the
          // external case id and resolve it to the central case at commit time.
          targetCaseInternalId = "PENDING_SAME_PACKAGE";
          targetCaseRef = parsed.case.payload.case_id;
        }
      } else {
        const ref = await db.externalCaseReference.findUnique({
          where: { providerType_externalSystem_externalCaseId: { providerType: PROVIDER_TYPE, externalSystem, externalCaseId: docCaseExternalId } },
        });
        if (ref) {
          targetCaseInternalId = ref.caseInternalId;
          const c = await db.case.findUnique({ where: { id: ref.caseInternalId }, select: { caseId: true } });
          targetCaseRef = c?.caseId ?? null;
        } else {
          targetCaseInternalId = null;
          targetCaseRef = null;
        }
      }

      if (!targetCaseInternalId || !targetCaseRef) {
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "DOCUMENT",
            externalId: doc.payload.document_id,
            resolution: "REJECT",
            payloadJson: JSON.stringify(doc.payload).slice(0, 8000),
            payloadPath: doc.payload.binary_path ?? null,
            binarySha256: doc.payload.sha256,
            validationStatus: "INVALID",
            processingStatus: "REJECTED",
            errorDetails: `Target case ${docCaseExternalId} is unknown to this platform — import the case package first.`,
          },
        });
        invalid += 1;
        continue;
      }

      // duplicate external reference (LINK_EXISTING, §44) — checked ALWAYS:
      // the (providerType, externalSystem, externalDocumentId) mapping is global,
      // so even a package-internal case may reference an already-mapped document.
      const existingDocRef = await db.externalDocumentReference.findUnique({
        where: { providerType_externalSystem_externalDocumentId: { providerType: PROVIDER_TYPE, externalSystem, externalDocumentId: doc.payload.document_id } },
      });
      // duplicate binary within the same target case (§44) — skipped when the
      // target case is created by THIS package (nothing can exist there yet).
      const existingBinary = targetCaseInternalId === "PENDING_SAME_PACKAGE"
        ? null
        : await db.caseDocument.findFirst({
            where: { caseId: targetCaseInternalId, sha256Hash: doc.payload.sha256, status: "COMMITTED" },
            select: { documentId: true, id: true },
          });

      if (existingDocRef && existingDocRef.documentInternalId !== existingBinary?.id) {
        const centralDoc = await db.caseDocument.findUnique({ where: { id: existingDocRef.documentInternalId }, select: { documentId: true, caseId: true, sha256Hash: true, classification: true, status: true } });
        if (centralDoc && centralDoc.caseId !== targetCaseInternalId) {
          await db.manualImportRecord.create({
            data: {
              importJobId: job.id,
              recordType: "DOCUMENT",
              externalId: doc.payload.document_id,
              resolution: "CONFLICT",
              targetEntityId: centralDoc.documentId,
              payloadJson: JSON.stringify(doc.payload).slice(0, 8000),
              payloadPath: doc.payload.binary_path ?? null,
              binarySha256: doc.payload.sha256,
              validationStatus: "VALID",
              conflictStatus: "CONFLICT",
              authorizationStatus: "PENDING",
              processingStatus: "STAGED",
              errorDetails: "External document reference points at a document in a different central case.",
            },
          });
          conflicts.push({ fieldName: "document_id", recordType: "DOCUMENT", recordExternalId: doc.payload.document_id, centralValue: centralDoc.documentId, incomingValue: doc.payload.document_id, sourceReference: doc.payload.binary_path ?? null, conflictType: "IMMUTABLE_FIELD" });
          valid += 1;
          continue;
        }
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "DOCUMENT",
            externalId: doc.payload.document_id,
            resolution: "LINK_EXISTING",
            targetEntityId: centralDoc?.documentId ?? null,
            payloadJson: JSON.stringify(doc.payload).slice(0, 8000),
            payloadPath: doc.payload.binary_path ?? null,
            binarySha256: doc.payload.sha256,
            validationStatus: "VALID",
            conflictStatus: "NONE",
            authorizationStatus: "PENDING",
            processingStatus: "STAGED",
          },
        });
        // §71/§73 — the central committed document is IMMUTABLE. If the package
        // claims different bytes or a different classification, that disagreement
        // becomes a CONFLICT (never an overwrite, never a downgrade).
        if (centralDoc && centralDoc.sha256Hash !== doc.payload.sha256) {
          conflicts.push({ fieldName: "document_sha256", recordType: "DOCUMENT", recordExternalId: doc.payload.document_id, centralValue: centralDoc.sha256Hash, incomingValue: doc.payload.sha256, sourceReference: doc.payload.binary_path ?? null, conflictType: "IMMUTABLE_FIELD" });
          await db.manualImportRecord.updateMany({ where: { importJobId: job.id, recordType: "DOCUMENT", externalId: doc.payload.document_id }, data: { conflictStatus: "CONFLICT", errorDetails: "Package declares a different binary for an already-committed document — conflict created, no overwrite." } });
        }
        if (centralDoc && classificationLevel(doc.payload.classification) !== classificationLevel(centralDoc.classification)) {
          conflicts.push({ fieldName: "classification", recordType: "DOCUMENT", recordExternalId: doc.payload.document_id, centralValue: centralDoc.classification, incomingValue: doc.payload.classification, sourceReference: "documents/metadata.json", conflictType: "CLASSIFICATION_POLICY" });
          await db.manualImportRecord.updateMany({ where: { importJobId: job.id, recordType: "DOCUMENT", externalId: doc.payload.document_id }, data: { conflictStatus: "CONFLICT" } });
        }
        valid += 1;
        continue;
      }

      if (existingBinary) {
        // §44 — identical binary already committed in this case: never re-create.
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "DOCUMENT",
            externalId: doc.payload.document_id,
            resolution: "LINK_EXISTING",
            targetEntityId: existingBinary.documentId,
            payloadJson: JSON.stringify(doc.payload).slice(0, 8000),
            payloadPath: doc.payload.binary_path ?? null,
            binarySha256: doc.payload.sha256,
            validationStatus: "VALID",
            conflictStatus: "NONE",
            authorizationStatus: "PENDING",
            processingStatus: "SKIPPED_DUPLICATE",
            errorDetails: "Identical binary (SHA-256) already committed in the target case — linked, not duplicated.",
          },
        });
        valid += 1;
        continue;
      }

      await db.manualImportRecord.create({
        data: {
          importJobId: job.id,
          recordType: "DOCUMENT",
          externalId: doc.payload.document_id,
          resolution: "CREATE",
          targetEntityId: targetCaseRef,
          payloadJson: JSON.stringify(doc.payload).slice(0, 8000),
          payloadPath: doc.payload.binary_path ?? null,
          binarySha256: doc.payload.sha256,
          validationStatus: "VALID",
          conflictStatus: "NONE",
          authorizationStatus: "PENDING",
          processingStatus: "STAGED",
        },
      });
      valid += 1;
    }

    // evidence (§34/§11/§72)
    for (const ev of parsed.evidence) {
      received += 1;
      let targetCaseInternalId = centralCaseInternalId;
      let targetCaseRef = centralCaseId;
      if (parsed.case && ev.payload.case_id === parsed.case.payload.case_id) {
        if (!centralCaseInternalId) {
          targetCaseInternalId = "PENDING_SAME_PACKAGE";
          targetCaseRef = parsed.case.payload.case_id;
        }
      } else {
        const ref = await db.externalCaseReference.findUnique({
          where: { providerType_externalSystem_externalCaseId: { providerType: PROVIDER_TYPE, externalSystem, externalCaseId: ev.payload.case_id } },
        });
        if (ref) {
          targetCaseInternalId = ref.caseInternalId;
          const c = await db.case.findUnique({ where: { id: ref.caseInternalId }, select: { caseId: true } });
          targetCaseRef = c?.caseId ?? null;
        } else {
          targetCaseInternalId = null;
          targetCaseRef = null;
        }
      }
      if (!targetCaseInternalId || !targetCaseRef) {
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "EVIDENCE",
            externalId: ev.payload.evidence_id,
            resolution: "REJECT",
            payloadJson: JSON.stringify(ev.payload).slice(0, 8000),
            payloadPath: ev.payload.binary_path ?? null,
            validationStatus: "INVALID",
            processingStatus: "REJECTED",
            errorDetails: `Target case ${ev.payload.case_id} is unknown to this platform — import the case package first.`,
          },
        });
        invalid += 1;
        continue;
      }
      const existingEvRef = targetCaseInternalId === "PENDING_SAME_PACKAGE"
        ? null
        : await db.externalEvidenceReference.findUnique({
            where: { providerType_externalSystem_externalEvidenceId: { providerType: PROVIDER_TYPE, externalSystem, externalEvidenceId: ev.payload.evidence_id } },
      });
      if (existingEvRef) {
        const centralEv = await db.evidence.findUnique({ where: { id: existingEvRef.evidenceInternalId }, select: { evidenceId: true } });
        await db.manualImportRecord.create({
          data: {
            importJobId: job.id,
            recordType: "EVIDENCE",
            externalId: ev.payload.evidence_id,
            resolution: "LINK_EXISTING",
            targetEntityId: centralEv?.evidenceId ?? null,
            payloadJson: JSON.stringify(ev.payload).slice(0, 8000),
            payloadPath: ev.payload.binary_path ?? null,
            validationStatus: "VALID",
            conflictStatus: "NONE",
            authorizationStatus: "PENDING",
            processingStatus: "STAGED",
          },
        });
        valid += 1;
        continue;
      }
      await db.manualImportRecord.create({
        data: {
          importJobId: job.id,
          recordType: "EVIDENCE",
          externalId: ev.payload.evidence_id,
          resolution: "CREATE",
          targetEntityId: targetCaseRef,
          payloadJson: JSON.stringify(ev.payload).slice(0, 8000),
          payloadPath: ev.payload.binary_path ?? null,
          validationStatus: "VALID",
          conflictStatus: "NONE",
          authorizationStatus: "PENDING",
          processingStatus: "STAGED",
        },
      });
      valid += 1;
    }

    // relationships (§35/§63): provenance decides whether the graph ever sees them
    for (const rel of parsed.relationships) {
      received += 1;
      await db.manualImportRecord.create({
        data: {
          importJobId: job.id,
          recordType: "RELATIONSHIP",
          externalId: rel.relationship_id,
          resolution: rel.provenance === "AUTHORITATIVE_IMPORT" ? "CREATE" : "LINK_EXISTING",
          payloadJson: JSON.stringify(rel).slice(0, 4000),
          validationStatus: "VALID",
          conflictStatus: "NONE",
          authorizationStatus: "PENDING",
          processingStatus: "STAGED",
        },
      });
      valid += 1;
    }

    // ---- conflicts persist (§36/§51) ----
    for (const c of conflicts) {
      const conflict = await db.manualImportConflict.create({
        data: {
          conflictId: await generateManualConflictId(),
          importJobId: job.id,
          recordType: c.recordType,
          recordRecordId: c.recordExternalId,
          fieldName: c.fieldName,
          centralValue: c.centralValue,
          incomingValue: c.incomingValue,
          sourceReference: c.sourceReference,
          conflictType: c.conflictType,
        },
      });
      await recordAuditEvent({
        eventType: "MANUAL_IMPORT_CONFLICT_CREATED",
        actorOfficerId: ctx.officer.id,
        metadata: { jobId, conflictId: conflict.conflictId, recordType: c.recordType, fieldName: c.fieldName, conflictType: c.conflictType },
      });
    }

    const requiresApproval =
      INTEROP_IMPORT_APPROVAL_POLICY === "ALWAYS_REQUIRED" ||
      conflicts.length > 0 ||
      packageRow.classification === "HIGHLY_RESTRICTED";

    const status = conflicts.length > 0 ? "REVIEW_REQUIRED" : "STAGED";
    const finished = await db.manualImportJob.update({
      where: { id: job.id },
      data: {
        status,
        stage: "STAGED",
        packageId: packageRow.packageId,
        packageType: parsed.manifest.package_type as PackageType,
        schemaVersion: parsed.manifest.schema_version,
        sourceSystem: parsed.manifest.source_system,
        sourceDepartment: parsed.manifest.source_department ?? null,
        packageTypeClassification: packageRow.classification,
        integrityResult: "MATCH",
        signatureStatus: signatureStatus.status,
        scanStatus,
        recordsReceived: received,
        recordsValid: valid,
        recordsInvalid: invalid,
        recordsConflicted: conflicts.length,
        requiresApproval,
      },
    });
    await recordAuditEvent({
      eventType: "MANUAL_IMPORT_STAGED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      metadata: { jobId, packageId: packageRow.packageId, recordsReceived: received, recordsValid: valid, recordsInvalid: invalid, conflicts: conflicts.length, requiresApproval },
    });

    return finished;
  },

  // ------------------------------------------------------------
  // STEP 14-15 — review + approval (§37/§39/§40/§74)
  // ------------------------------------------------------------
  async getReview(ctx: AuthContext, jobId: string) {
    const job = await db.manualImportJob.findUnique({
      where: { jobId },
      include: {
        records: true,
        approvals: { include: { reviewerOfficer: { select: { officerId: true, name: true } } } },
      },
    });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    // visibility: uploader's department, reviewers, system admin
    if (ctx.officer.role !== "SYSTEM_ADMIN" && ctx.officer.departmentId !== job.uploadedByDepartmentId) {
      throw new ApiError(403, "REVIEW_ACCESS_DENIED", "You are not authorized to view this import job.");
    }
    const conflicts = await db.manualImportConflict.findMany({ where: { importJobId: job.id }, orderBy: { createdAt: "asc" } });
    return { job, records: job.records, approvals: job.approvals, conflicts, interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration." };
  },

  async approve(ctx: AuthContext, jobId: string, comment: string | null) {
    const job = await db.manualImportJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    if (!["STAGED", "REVIEW_REQUIRED"].includes(job.status)) {
      throw new ApiError(409, "APPROVE_NOT_ALLOWED", `Import job is ${job.status}; approval is only available for STAGED/REVIEW_REQUIRED jobs.`);
    }
    if (INTEROP_SEPARATION_OF_DUTIES && job.uploadedByOfficerId === ctx.officer.id) {
      await recordAuditEvent({
        eventType: "MANUAL_IMPORT_REVIEWED",
        actorOfficerId: ctx.officer.id,
        result: "DENIED",
        metadata: { jobId, reason: "SEPARATION_OF_DUTIES" },
      });
      throw new ApiError(403, "SEPARATION_OF_DUTIES", "The uploading officer cannot approve their own import (separation of duties).");
    }
    const unresolved = await db.manualImportConflict.count({ where: { importJobId: job.id, status: "OPEN" } });
    if (unresolved > 0) {
      throw new ApiError(409, "CONFLICTS_UNRESOLVED", `${unresolved} conflict(s) must be resolved before approval.`);
    }
    const invalid = await db.manualImportRecord.count({ where: { importJobId: job.id, processingStatus: "REJECTED" } });
    const decision = invalid > 0 ? "PARTIALLY_APPROVED" : "APPROVED";

    await db.importApproval.create({
      data: {
        importJobId: job.id,
        reviewerOfficerId: ctx.officer.id,
        reviewerDepartmentId: ctx.officer.departmentId,
        decision,
        comment: comment?.slice(0, 500) ?? null,
      },
    });
    const updated = await db.manualImportJob.update({ where: { id: job.id }, data: { status: "APPROVED", stage: "APPROVED" } });
    await recordAuditEvent({
      eventType: decision === "APPROVED" ? "MANUAL_IMPORT_APPROVED" : "MANUAL_IMPORT_REVIEWED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, decision, comment: comment?.slice(0, 200) ?? null },
    });
    return updated;
  },

  async reject(ctx: AuthContext, jobId: string, comment: string | null) {
    const job = await db.manualImportJob.findUnique({ where: { jobId } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    if (["COMPLETED", "PARTIAL", "REJECTED", "CANCELLED"].includes(job.status)) {
      throw new ApiError(409, "REJECT_NOT_ALLOWED", `Import job is ${job.status}.`);
    }
    if (INTEROP_SEPARATION_OF_DUTIES && job.uploadedByOfficerId === ctx.officer.id && job.status !== "UPLOADED") {
      throw new ApiError(403, "SEPARATION_OF_DUTIES", "The uploading officer cannot decide on their own import (separation of duties).");
    }
    await db.importApproval.create({
      data: {
        importJobId: job.id,
        reviewerOfficerId: ctx.officer.id,
        reviewerDepartmentId: ctx.officer.departmentId,
        decision: "REJECTED",
        comment: comment?.slice(0, 500) ?? null,
      },
    });
    const updated = await db.manualImportJob.update({ where: { id: job.id }, data: { status: "REJECTED", stage: "REJECTED", completedAt: new Date() } });
    await recordAuditEvent({
      eventType: "MANUAL_IMPORT_REJECTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { jobId, comment: comment?.slice(0, 200) ?? null },
    });
    return updated;
  },

  // ------------------------------------------------------------
  // Conflict resolution (§36/§37/§41/§73)
  // ------------------------------------------------------------
  async resolveConflict(ctx: AuthContext, conflictId: string, resolution: ConflictResolution, note: string | null) {
    const conflict = await db.manualImportConflict.findUnique({ where: { conflictId }, include: { importJob: true } });
    if (!conflict) throw new ApiError(404, "NOT_FOUND", "Conflict not found.");
    if (conflict.status !== "OPEN") throw new ApiError(409, "ALREADY_RESOLVED", "Conflict already resolved.");
    if (["COMPLETED", "PARTIAL", "FAILED", "REJECTED", "CANCELLED"].includes(conflict.importJob.status)) {
      throw new ApiError(409, "RESOLVE_NOT_ALLOWED", `Import job is ${conflict.importJob.status}.`);
    }

    // §73: classification policy — never allow the LESS restrictive value.
    if (conflict.conflictType === "CLASSIFICATION_POLICY") {
      const central = conflict.centralValue ?? "INTERNAL";
      const incoming = conflict.incomingValue ?? "INTERNAL";
      const downgradePick = resolution === "ACCEPT_INCOMING" && classificationLevel(incoming) < classificationLevel(central);
      if (downgradePick) {
        throw new ApiError(422, "CLASSIFICATION_DOWNGRADE_REJECTED", "Accepting the incoming value would downgrade the central classification — policy forbids it.");
      }
    }
    // §38: immutable-field conflicts can only be kept central or reject the record.
    if (conflict.conflictType === "IMMUTABLE_FIELD" && ["ACCEPT_INCOMING", "MERGE"].includes(resolution)) {
      throw new ApiError(422, "IMMUTABLE_FIELD_PROTECTED", "Immutable central fields cannot be overwritten — choose KEEP_CENTRAL or REJECT_RECORD.");
    }
    // Case field updates need case-level manage on the resolver.
    if (conflict.recordType === "CASE" && ["ACCEPT_INCOMING", "MERGE"].includes(resolution)) {
      const caseRecord = await db.manualImportRecord.findFirst({
        where: { importJobId: conflict.importJobId, recordType: "CASE" },
        select: { targetEntityId: true },
      });
      if (caseRecord?.targetEntityId) {
        const { assertCaseManage } = await import("@/lib/cases/access");
        await assertCaseManage(ctx, caseRecord.targetEntityId);
      }
    }

    const updated = await db.manualImportConflict.update({
      where: { id: conflict.id },
      data: {
        status: resolution,
        resolvedByOfficerId: ctx.officer.id,
        resolvedAt: new Date(),
        resolutionNote: note?.slice(0, 500) ?? null,
      },
    });
    if (resolution === "REJECT_RECORD") {
      await db.manualImportRecord.updateMany({
        where: { importJobId: conflict.importJobId, recordType: conflict.recordType, externalId: conflict.recordRecordId ?? "" },
        data: { processingStatus: "REJECTED", errorDetails: `Rejected via conflict ${conflict.conflictId}.` },
      });
    }
    await recordAuditEvent({
      eventType: "MANUAL_IMPORT_CONFLICT_RESOLVED",
      actorOfficerId: ctx.officer.id,
      sessionId: ctx.sessionId,
      metadata: { jobId: conflict.importJob.jobId, conflictId, resolution, recordType: conflict.recordType, fieldName: conflict.fieldName },
    });
    return updated;
  },

  // ------------------------------------------------------------
  // STEP 16 — final import (§31-§34/§45-§47/§62/§63)
  // ------------------------------------------------------------
  async commit(ctx: AuthContext, jobId: string) {
    const job = await db.manualImportJob.findUnique({ where: { jobId }, include: { records: true } });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    const commitAllowed = job.status === "APPROVED" || (job.status === "STAGED" && !job.requiresApproval);
    if (!commitAllowed) {
      throw new ApiError(409, "COMMIT_NOT_ALLOWED", `Import job is ${job.status}; commit requires approval.`);
    }
    if (!job.packageId) throw new ApiError(409, "PACKAGE_NOT_VALIDATED", "Run validation before committing.");

    await db.manualImportJob.update({ where: { id: job.id }, data: { status: "IMPORTING", stage: "IMPORTING" } });

    const parsed = await this.reloadParsed(job.packageStorageKey, job.packageKeyReference);
    const externalSystem = parsed.manifest.source_system;
    const byExternalId = new Map(parsed.documents.map((d) => [d.payload.document_id, d]));
    const evByExternalId = new Map(parsed.evidence.map((e) => [e.payload.evidence_id, e]));

    const counters = { received: job.records.length, imported: 0, rejected: 0, conflicted: 0, skipped: 0 };
    const affectedCaseRefs = new Set<string>();
    let committedCaseInternalId: string | null = null;
    let committedCaseRef: string | null = null;

    const conflictResolutions = await db.manualImportConflict.findMany({ where: { importJobId: job.id, NOT: { status: "OPEN" } } });
    const resolutionByRecord = new Map(conflictResolutions.map((c) => [`${c.recordType}:${c.recordRecordId}`, c]));

    try {
      // ---- records in dependency order: CASE → DOCUMENT → EVIDENCE → RELATIONSHIP ----
      for (const record of [...job.records].sort((a, b) => {
        const order: Record<string, number> = { CASE: 0, DOCUMENT: 1, EVIDENCE: 2, RELATIONSHIP: 3 };
        return (order[a.recordType] ?? 9) - (order[b.recordType] ?? 9);
      })) {
        const resolution = resolutionByRecord.get(`${record.recordType}:${record.externalId}`);
        if (record.processingStatus === "REJECTED" || resolution?.status === "REJECT_RECORD") {
          counters.rejected += 1;
          await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "REJECTED" } });
          continue;
        }

        try {
          if (record.recordType === "CASE") {
            const payload = JSON.parse(record.payloadJson!) as CasePayload;
            if (record.resolution === "CREATE") {
              // §31 — new central case, geo = uploader's department (importing office)
              const { generateCaseId } = await import("@/lib/cases/ids");
              const dept = await db.department.findUnique({
                where: { id: ctx.officer.departmentId },
                include: { city: { include: { district: { include: { state: true } } } } },
              });
              if (!dept) throw new Error("IMPORTER_DEPARTMENT_MISSING");
              const caseId = await generateCaseId(
                { state: { code: dept.city.district.state.code }, district: { code: dept.city.district.code } },
                new Date().getFullYear()
              );
              // §47 — atomic: case + participation + provenance + event
              const created = await db.$transaction(async (tx) => {
                const row = await tx.case.create({
                  data: {
                    caseId,
                    caseNumber: payload.official_case_number ?? null,
                    title: payload.title.slice(0, 200),
                    description: payload.description ?? null,
                    caseType: payload.case_type,
                    caseCategory: payload.case_category ?? null,
                    priority: ["LOW", "NORMAL", "HIGH", "CRITICAL"].includes(payload.priority) ? payload.priority : "NORMAL",
                    status: "OPEN",
                    stateId: dept.stateId,
                    districtId: dept.districtId,
                    cityId: dept.cityId,
                    originatingDepartmentId: dept.id,
                    currentCustodianDepartmentId: dept.id,
                    currentCustodianOfficerId: ctx.officer.id,
                    createdByOfficerId: ctx.officer.id,
                    createdByDepartmentId: ctx.officer.departmentId,
                    openedAt: new Date(),
                  },
                });
                await tx.caseDepartment.create({
                  data: { caseId: row.id, departmentId: dept.id, participationType: "ORIGINATING", addedByOfficerId: ctx.officer.id, note: `Originating participation via manual package import (${parsed.manifest.source_system})` },
                });
                await tx.caseEvent.create({
                  data: {
                    caseId: row.id,
                    eventType: "CASE_CREATED",
                    actorOfficerId: ctx.officer.id,
                    departmentId: ctx.officer.departmentId,
                    description: `Case imported from manual package ${job.packageId} (source: ${parsed.manifest.source_system}, external id ${payload.case_id}) — manual transfer, not a live integration.`,
                    metadata: JSON.stringify({ sourcePackageId: job.packageId, sourceSystem: parsed.manifest.source_system, externalCaseId: payload.case_id }),
                  },
                });
                await tx.externalCaseReference.create({
                  data: {
                    caseInternalId: row.id,
                    providerType: PROVIDER_TYPE,
                    externalSystem,
                    externalCaseId: payload.case_id,
                    externalCaseNumber: payload.official_case_number ?? null,
                    sourceHash: record.binarySha256 ?? null,
                    schemaVersion: parsed.manifest.schema_version,
                    importedByOfficerId: ctx.officer.id,
                    importJobId: job.jobId,
                  },
                });
                return row;
              });
              committedCaseInternalId = created.id;
              committedCaseRef = created.caseId;
              affectedCaseRefs.add(created.caseId);
              counters.imported += 1;
              await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", targetEntityId: created.caseId, authorizationStatus: "AUTHORIZED" } });
              await recordAuditEvent({
                eventType: "MANUAL_IMPORT_COMPLETED",
                actorOfficerId: ctx.officer.id,
                caseId: created.caseId,
                metadata: { jobId, recordType: "CASE", externalId: record.externalId, centralCaseId: created.caseId, action: "CREATE" },
              });
            } else if (record.resolution === "LINK_EXISTING") {
              // apply approved field updates (§37) — only INTEROP_CASE_MUTABLE_FIELDS
              for (const field of INTEROP_CASE_MUTABLE_FIELDS) {
                const res = resolutionByRecord.get(`CASE:${record.externalId}`);
                if (res && ["ACCEPT_INCOMING", "MERGE"].includes(res.status)) {
                  const incoming = (payload as unknown as Record<string, unknown>)[field];
                  if (typeof incoming === "string" && INTEROP_CASE_MUTABLE_FIELDS.includes(field as never)) {
                    await db.case.update({ where: { id: committedCaseInternalId ?? (await this.findCaseInternal(record.targetEntityId!)) }, data: { [field]: incoming.slice(0, field === "title" ? 200 : 4000) } });
                  }
                }
              }
              committedCaseInternalId = await this.findCaseInternal(record.targetEntityId!);
              committedCaseRef = record.targetEntityId;
              affectedCaseRefs.add(record.targetEntityId!);
              counters.imported += 1;
              await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", authorizationStatus: "AUTHORIZED" } });
            }
          } else if (record.recordType === "DOCUMENT") {
            const targetInternal = committedCaseInternalId ?? (await this.findCaseInternal(record.targetEntityId!));
            const targetRef = committedCaseRef ?? record.targetEntityId!;
            const caseRow = await db.case.findUnique({ where: { id: targetInternal }, select: { id: true, caseId: true, status: true } });
            if (!caseRow) throw new Error("TARGET_CASE_MISSING");

            if (record.resolution === "LINK_EXISTING" && record.processingStatus === "SKIPPED_DUPLICATE") {
              counters.skipped += 1;
              affectedCaseRefs.add(caseRow.caseId);
              continue;
            }
            if (record.resolution === "LINK_EXISTING") {
              counters.imported += 1;
              affectedCaseRefs.add(caseRow.caseId);
              await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", authorizationStatus: "AUTHORIZED" } });
              continue;
            }

            const doc = byExternalId.get(record.externalId);
            if (!doc?.binary) throw new Error("DOCUMENT_BINARY_MISSING");

            // §32 — REAL Phase 3 pipeline (validate → scan → hash → encrypt → store → commit).
            // The declared sha256 was already verified against the actual bytes by
            // parsePackage — hash verification is enforced again inside uploadAndCommit.
            const upload = await uploadAndCommit({
              ctx,
              caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
              input: {
                title: doc.payload.title.slice(0, 200),
                description: `Imported from manual package ${job.packageId} (source: ${parsed.manifest.source_system}, external id ${record.externalId}) — manual transfer, not a live integration.`,
                documentType: doc.payload.document_type,
                documentCategory: doc.payload.document_category ?? null,
                classification: doc.payload.classification,
                documentDate: doc.payload.document_date ? new Date(doc.payload.document_date) : null,
                externalReference: record.externalId.slice(0, 100),
                tags: ["MANUAL_PACKAGE_IMPORT", `package:${job.packageId}`],
                clientRequestId: `interop:${job.jobId}:${record.externalId}`,
              },
              file: { buffer: doc.binary, originalFilename: doc.payload.original_filename, declaredMimeType: doc.payload.mime_type },
            });

            await db.externalDocumentReference.create({
              data: {
                documentInternalId: upload.document.id,
                providerType: PROVIDER_TYPE,
                externalSystem,
                externalDocumentId: record.externalId,
                externalReference: doc.payload.original_filename.slice(0, 120),
                sourceHash: doc.payload.sha256,
                centralHash: doc.payload.sha256,
                hashVerified: true,
                importedByOfficerId: ctx.officer.id,
                importJobId: job.jobId,
              },
            });
            await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", targetEntityId: upload.document.documentId, authorizationStatus: "AUTHORIZED" } });
            affectedCaseRefs.add(caseRow.caseId);
            counters.imported += 1;
            await recordAuditEvent({
              eventType: "MANUAL_IMPORT_COMPLETED",
              actorOfficerId: ctx.officer.id,
              caseId: caseRow.caseId,
              documentId: upload.document.documentId,
              metadata: { jobId, recordType: "DOCUMENT", externalId: record.externalId, centralDocumentId: upload.document.documentId, sha256: doc.payload.sha256.slice(0, 16) },
            });

            // §62 — Phase 5 AI: same auto-enqueue path as native uploads
            // (LOCAL_ONLY default + classification policy respected inside).
            await autoEnqueueAfterCommit({
              ctx,
              caseInternalId: caseRow.id,
              caseRef: caseRow.caseId,
              documentInternalId: upload.document.id,
              documentRef: upload.document.documentId,
            }).catch(() => undefined);
          } else if (record.recordType === "EVIDENCE") {
            const targetInternal = committedCaseInternalId ?? (await this.findCaseInternal(record.targetEntityId!));
            const caseRow = await db.case.findUnique({ where: { id: targetInternal }, select: { id: true, caseId: true, status: true } });
            if (!caseRow) throw new Error("TARGET_CASE_MISSING");

            if (record.resolution === "LINK_EXISTING") {
              counters.imported += 1;
              affectedCaseRefs.add(caseRow.caseId);
              await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", authorizationStatus: "AUTHORIZED" } });
              continue;
            }

            const ev = evByExternalId.get(record.externalId);
            if (!ev) throw new Error("EVIDENCE_PAYLOAD_MISSING");

            // §34/§72 — custody NEVER written by imports. Transfer claims in the
            // package become provenance notes; the custody workflow stays authoritative.
            const custodyNote = ev.payload.custody_history_available
              ? `Source custody trail (from package, ${ev.payload.custody_trail?.length ?? 0} records) provided for reference — platform custody remains authoritative and untouched.`
              : "HISTORY_UNAVAILABLE — package did not provide historical custody; none was invented.";
            const provenanceNote = [
              `SOURCE: manual package ${job.packageId} (${parsed.manifest.source_system}), external id ${record.externalId}.`,
              `Source custodian: ${ev.payload.custodian_department ?? "UNSPECIFIED"}.`,
              custodyNote,
              "Any custody change must follow the platform evidence transfer workflow — the import does NOT modify custody.",
            ].join(" ");

            const registered = await registerEvidence({
              ctx,
              caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
              input: {
                title: ev.payload.title.slice(0, 200),
                description: `${ev.payload.description ?? ""}${ev.payload.description ? " " : ""}${provenanceNote}`.slice(0, 2000) || null,
                evidenceType: ev.payload.evidence_type,
                category: ev.payload.category ?? null,
                classification: ev.payload.classification,
                sourceType: "EXTERNAL_IMPORT",
                sourceReference: record.externalId.slice(0, 100),
                collectionLocation: ev.payload.collection_location ?? null,
                collectedAt: ev.payload.collected_at ? new Date(ev.payload.collected_at) : null,
                notes: provenanceNote.slice(0, 1000),
              },
              file: ev.binary ? { buffer: ev.binary, originalFilename: `evidence-${record.externalId}.bin`, declaredMimeType: "application/octet-stream" } : undefined,
            });

            await db.externalEvidenceReference.create({
              data: {
                evidenceInternalId: registered.evidence.id,
                providerType: PROVIDER_TYPE,
                externalSystem,
                externalEvidenceId: record.externalId,
                externalReference: ev.payload.title.slice(0, 120),
                custodyHistoryAvailable: ev.payload.custody_history_available,
                sourceCustodian: ev.payload.custodian_department?.slice(0, 120) ?? null,
                sourceDepartment: parsed.manifest.source_department ?? null,
                sourceHash: ev.payload.sha256 ?? null,
                importJobId: job.jobId,
                importedByOfficerId: ctx.officer.id,
              },
            });
            await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", targetEntityId: registered.evidence.evidenceId, authorizationStatus: "AUTHORIZED" } });
            affectedCaseRefs.add(caseRow.caseId);
            counters.imported += 1;
            await recordAuditEvent({
              eventType: "MANUAL_IMPORT_COMPLETED",
              actorOfficerId: ctx.officer.id,
              caseId: caseRow.caseId,
              evidenceId: registered.evidence.evidenceId,
              metadata: { jobId, recordType: "EVIDENCE", externalId: record.externalId, custodyModified: false },
            });
          } else if (record.recordType === "RELATIONSHIP") {
            const rel = JSON.parse(record.payloadJson!) as NonNullable<ParsedPackage["relationships"]>[number];
            if (rel.provenance === "AUTHORITATIVE_IMPORT" && record.resolution === "CREATE") {
              // resolve both endpoints to central documents
              const sourceDoc = await this.resolveDocumentRef(ctx, rel.source_id, externalSystem, job.jobId);
              const targetDoc = await this.resolveDocumentRef(ctx, rel.target_id, externalSystem, job.jobId);
              if (!sourceDoc || !targetDoc) throw new Error("RELATIONSHIP_ENDPOINT_UNRESOLVED");
              const exists = await db.documentRelationship.findUnique({
                where: { sourceDocumentId_targetDocumentId_relationshipType: { sourceDocumentId: sourceDoc.id, targetDocumentId: targetDoc.id, relationshipType: rel.relationship_type } },
              });
              if (!exists) {
                await db.documentRelationship.create({
                  data: {
                    sourceDocumentId: sourceDoc.id,
                    targetDocumentId: targetDoc.id,
                    relationshipType: rel.relationship_type,
                    createdByOfficerId: ctx.officer.id,
                  },
                });
              }
              counters.imported += 1;
              await db.manualImportRecord.update({ where: { id: record.id }, data: { processingStatus: "IMPORTED", targetEntityId: `${sourceDoc.documentId}->${targetDoc.documentId}`, authorizationStatus: "AUTHORIZED" } });
            } else {
              // §35 — IMPORTED_REFERENCE never becomes a confirmed relationship.
              counters.skipped += 1;
              await db.manualImportRecord.update({
                where: { id: record.id },
                data: { processingStatus: "IMPORTED", authorizationStatus: "AUTHORIZED", errorDetails: "IMPORTED_REFERENCE — recorded for provenance only; not a confirmed central relationship." },
              });
            }
          }
        } catch (recordErr) {
          counters.rejected += 1;
          const message = recordErr instanceof Error ? recordErr.message.slice(0, 240) : "Record failed.";
          await db.manualImportRecord.update({
            where: { id: record.id },
            data: { processingStatus: "REJECTED", errorDetails: message },
          });
          await recordAuditEvent({
            eventType: "MANUAL_IMPORT_FAILED",
            actorOfficerId: ctx.officer.id,
            result: "FAILED",
            metadata: { jobId, recordType: record.recordType, externalId: record.externalId },
          });
        }
      }

      // ---- final status (§45): PARTIAL is honest, never fake SUCCESS ----
      const terminal = counters.rejected > 0 ? (counters.imported > 0 || counters.skipped > 0 ? "PARTIAL" : "FAILED") : "COMPLETED";
      const finished = await db.manualImportJob.update({
        where: { id: job.id },
        data: {
          status: terminal,
          stage: terminal,
          recordsImported: counters.imported,
          recordsInvalid: counters.rejected,
          recordsConflicted: counters.conflicted,
          completedAt: new Date(),
        },
      });
      await recordAuditEvent({
        eventType: terminal === "COMPLETED" ? "MANUAL_IMPORT_COMPLETED" : terminal === "PARTIAL" ? "MANUAL_IMPORT_PARTIAL" : "MANUAL_IMPORT_FAILED",
        actorOfficerId: ctx.officer.id,
        sessionId: ctx.sessionId,
        metadata: { jobId, packageId: job.packageId, ...counters },
      });

      // ---- §63 — graph sync via the Phase 6 GraphSyncService for affected cases ----
      const graphResults: { caseRef: string; ok: boolean; error?: string }[] = [];
      for (const caseRef of affectedCaseRefs) {
        try {
          const { syncCaseGraph } = await import("@/lib/graph/graph-sync");
          await syncCaseGraph(caseRef);
          graphResults.push({ caseRef, ok: true });
        } catch (err) {
          graphResults.push({ caseRef, ok: false, error: err instanceof Error ? err.message.slice(0, 120) : "sync failed" });
        }
      }

      return {
        job: finished,
        counters,
        graphSync: graphResults,
        interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
      };
    } catch (err) {
      // §46 — rollback semantics: record-level failures are contained above;
      // a failure HERE means the job itself could not finish — mark FAILED.
      await db.manualImportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", stage: "IMPORT_FAILED", ...jobErr("IMPORT_FAILED", err instanceof Error ? err.message.slice(0, 240) : "Import failed."), completedAt: new Date() },
      });
      throw err;
    }
  },

  async findCaseInternal(caseRef: string): Promise<string> {
    const row = await db.case.findUnique({ where: { caseId: caseRef }, select: { id: true } });
    if (!row) throw new Error(`TARGET_CASE_MISSING:${caseRef}`);
    return row.id;
  },

  async resolveDocumentRef(ctx: AuthContext, externalDocumentId: string, externalSystem: string, importJobId: string) {
    const ref = await db.externalDocumentReference.findUnique({
      where: { providerType_externalSystem_externalDocumentId: { providerType: PROVIDER_TYPE, externalSystem, externalDocumentId } },
    });
    if (ref) {
      const doc = await db.caseDocument.findUnique({ where: { id: ref.documentInternalId }, select: { id: true, documentId: true } });
      if (doc) return doc;
    }
    // endpoint may have been created in THIS job — resolve via import records
    const record = await db.manualImportRecord.findFirst({
      where: { importJobId, recordType: "DOCUMENT", externalId: externalDocumentId, processingStatus: "IMPORTED" },
      select: { targetEntityId: true },
    });
    if (record?.targetEntityId) {
      const doc = await db.caseDocument.findUnique({ where: { documentId: record.targetEntityId }, select: { id: true, documentId: true } });
      if (doc) return doc;
    }
    return null;
  },

  async reloadParsed(storageKey: string | null, keyReference: string | null): Promise<ParsedPackage> {
    if (!storageKey) throw new ApiError(409, "NO_PACKAGE", "Import job has no staged package.");
    const stored = await DocumentStorage.get_object(storageKey);
    const archive = await packageEncryptionService.decryptPackage(stored, keyReference);
    return parsePackage(archive);
  },

  async listJobs(ctx: AuthContext) {
    const where = ctx.officer.role === "SYSTEM_ADMIN" ? {} : { uploadedByDepartmentId: ctx.officer.departmentId };
    return db.manualImportJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        jobId: true, packageId: true, status: true, stage: true, packageType: true, schemaVersion: true,
        sourceSystem: true, packageTypeClassification: true, integrityResult: true, signatureStatus: true, scanStatus: true,
        recordsReceived: true, recordsValid: true, recordsInvalid: true, recordsConflicted: true, recordsImported: true,
        requiresApproval: true, errorSummary: true, errorCode: true, startedAt: true, completedAt: true, createdAt: true,
        uploadedByOfficer: { select: { officerId: true, name: true } },
      },
    });
  },

  async getJob(ctx: AuthContext, jobId: string) {
    const job = await db.manualImportJob.findUnique({
      where: { jobId },
      include: { records: true, approvals: { include: { reviewerOfficer: { select: { officerId: true, name: true } } } } },
    });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Import job not found.");
    if (ctx.officer.role !== "SYSTEM_ADMIN" && ctx.officer.departmentId !== job.uploadedByDepartmentId) {
      throw new ApiError(403, "JOB_ACCESS_DENIED", "You are not authorized to view this import job.");
    }
    const conflicts = await db.manualImportConflict.findMany({ where: { importJobId: job.id }, orderBy: { createdAt: "asc" } });
    const packageRow = job.packageId ? await db.packageRecord.findUnique({ where: { packageId: job.packageId }, include: { signatures: true, integrityChecks: true } }) : null;
    return {
      job: { ...job, records: undefined, approvals: undefined },
      records: job.records,
      approvals: job.approvals,
      conflicts,
      package: packageRow
        ? {
            packageId: packageRow.packageId,
            packageType: packageRow.packageType,
            schemaVersion: packageRow.schemaVersion,
            sourceSystem: packageRow.sourceSystem,
            sourceDepartment: packageRow.sourceDepartment,
            createdInEnvironment: packageRow.createdInEnvironment,
            classification: packageRow.classification,
            caseCount: packageRow.caseCount,
            documentCount: packageRow.documentCount,
            evidenceCount: packageRow.evidenceCount,
            relationshipCount: packageRow.relationshipCount,
            packageIntegrity: packageRow.packageIntegrity,
            packageSha256: packageRow.packageSha256,
            manifestHash: packageRow.manifestHash,
            signature: packageRow.signatures[0] ?? null,
            integrityChecks: packageRow.integrityChecks,
            createdAt: packageRow.createdAt,
          }
        : null,
      interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
    };
  },

  async listConflicts(ctx: AuthContext, jobId?: string) {
    const where = jobId ? { importJob: { jobId } } : {};
    const conflicts = await db.manualImportConflict.findMany({
      where,
      include: { importJob: { select: { jobId: true, status: true, uploadedByDepartmentId: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return conflicts.filter((c) => ctx.officer.role === "SYSTEM_ADMIN" || c.importJob.uploadedByDepartmentId === ctx.officer.departmentId);
  },

  async getPackage(packageId: string) {
    const row = await db.packageRecord.findUnique({
      where: { packageId },
      include: { files: true, signatures: true, integrityChecks: true, downloads: { select: { downloadedByOfficerId: true, downloadedAt: true } } },
    });
    if (!row) throw new ApiError(404, "NOT_FOUND", "Package not found.");
    return {
      ...row,
      downloads: row.downloads.length,
      interopNote: "MANUAL PACKAGE TRANSFER — not a live system integration.",
    };
  },
};

void PACKAGE_CLASSIFICATIONS;
