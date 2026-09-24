import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import type { CaseEventType } from "@/lib/constants";
import { validateUploadedFile } from "@/lib/documents/validation";
import { EVIDENCE_ALLOWED_EXTENSIONS } from "@/lib/constants";
import { scanFileContent } from "@/lib/documents/scanner";
import { calculateSha256, verifyHash } from "@/lib/documents/integrity";
import { encryptDocument, decryptDocument } from "@/lib/documents/encryption";
import { DocumentStorage, buildEvidenceStorageKey } from "@/lib/documents/storage";
import { appendAuditEvent, recordAuditEvent } from "@/lib/audit/service";
import { generateEvidenceId } from "@/lib/cases/ids";
import { recordCaseEvent } from "@/lib/cases/events";

// ============================================================
// EvidenceService (spec §5/§10/§11/§13/§39).
//
// The ONLY writer of Evidence rows. Registration follows spec §39:
//
//   DIGITAL:  REGISTER → VALIDATE → SCAN → HASH (SHA-256 over
//             plaintext) → ENCRYPT (AES-256-GCM) → STORE (Phase 3
//             storage abstraction, spec §12) → COMMIT (single DB
//             transaction: evidence row + custody + audit events)
//
//   PHYSICAL: REGISTER → METADATA COMMIT → CUSTODY RECORD → AUDIT
//
// Server derives registeredBy / custodian / hashes — clients can
// never submit identity, storage or integrity fields. A failed
// digital upload leaves NO evidence row; the staged object is
// cleaned up (no partial commits, mirroring Phase 3 §22/§23).
//
// AUDIT ATOMICITY (spec §48/§49): evidence creation and its
// EVIDENCE_CREATED/EVIDENCE_COMMITTED audit events are written in
// the SAME transaction — if audit recording fails, registration
// fails. Read-path events are best-effort (documented policy).
// ============================================================

export interface EvidenceRegisterInput {
  title: string;
  description?: string | null;
  evidenceType: string;
  category?: string | null;
  classification: string;
  sourceType: string;
  sourceReference?: string | null;
  collectionLocation?: string | null;
  collectedAt?: Date | null;
  collectedByOfficerId?: string | null; // public officerId, resolved server-side
  condition?: string | null;
  notes?: string | null;
  evidenceNumber?: string | null;
  deviceMetadata?: Record<string, unknown> | null;
  receivedAt?: Date | null;
}

export interface EvidenceRegisterFiles {
  buffer: Buffer;
  originalFilename: string;
  declaredMimeType: string | null | undefined;
}

interface CaseRowMinimal {
  id: string;
  caseId: string;
  status: string;
}

export interface EvidenceSummaryRow {
  id: string;
  evidenceId: string;
  caseId: string; // internal — replaced with public id by toEvidenceSummary
  evidenceNumber: string | null;
  title: string;
  description: string | null;
  evidenceType: string;
  category: string | null;
  status: string;
  classification: string;
  sourceType: string;
  sourceReference: string | null;
  collectionLocation: string | null;
  collectedAt: Date | null;
  receivedAt: Date | null;
  condition: string | null;
  notes: string | null;
  deviceMetadata: string | null;
  hasDigitalContent: boolean;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  sha256Hash: string | null;
  hashAlgorithm: string;
  encryptionStatus: string | null;
  registeredByOfficer: { officerId: string; name: string } | null;
  registeredByDepartmentId: string;
  currentCustodianDepartmentId: string | null;
  currentCustodianDepartment: { id: string; departmentCode: string; name: string; departmentType: string } | null;
  currentCustodianOfficer: { officerId: string; name: string } | null;
  collectedByOfficer: { officerId: string; name: string } | null;
  collectingDepartment: { id: string; departmentCode: string; name: string; departmentType: string } | null;
  version: number;
  committedAt: Date | null;
  createdAt: Date;
}

const SUMMARY_SELECT = {
  id: true,
  evidenceId: true,
  caseId: true,
  evidenceNumber: true,
  title: true,
  description: true,
  evidenceType: true,
  category: true,
  status: true,
  classification: true,
  sourceType: true,
  sourceReference: true,
  collectionLocation: true,
  collectedAt: true,
  receivedAt: true,
  condition: true,
  notes: true,
  deviceMetadata: true,
  hasDigitalContent: true,
  originalFilename: true,
  mimeType: true,
  fileSize: true,
  sha256Hash: true,
  hashAlgorithm: true,
  encryptionStatus: true,
  registeredByOfficer: { select: { officerId: true, name: true } },
  registeredByDepartmentId: true,
  currentCustodianDepartmentId: true,
  currentCustodianDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
  currentCustodianOfficer: { select: { officerId: true, name: true } },
  collectedByOfficer: { select: { officerId: true, name: true } },
  collectingDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
  version: true,
  committedAt: true,
  createdAt: true,
} as const;

/** API-facing projection — storageKey/keyReference/internal ids NEVER leave the server (spec §5). */
export function toEvidenceSummary(evidence: EvidenceSummaryRow, casePublicId: string) {
  // Explicit whitelist — an allowlist (not a delete-list) is the only way
  // to guarantee that storageKey, keyReference and internal ids can never
  // leak through object spread, whatever the input row actually contains.
  return {
    id: evidence.evidenceId,
    caseId: casePublicId,
    evidenceNumber: evidence.evidenceNumber ?? null,
    title: evidence.title,
    description: evidence.description ?? null,
    evidenceType: evidence.evidenceType,
    category: evidence.category ?? null,
    status: evidence.status,
    classification: evidence.classification,
    sourceType: evidence.sourceType,
    sourceReference: evidence.sourceReference ?? null,
    collectionLocation: evidence.collectionLocation ?? null,
    collectedAt: evidence.collectedAt ?? null,
    receivedAt: evidence.receivedAt ?? null,
    condition: evidence.condition ?? null,
    notes: evidence.notes ?? null,
    deviceMetadata: evidence.deviceMetadata ? safeParse(evidence.deviceMetadata) : null,
    hasDigitalContent: evidence.hasDigitalContent,
    originalFilename: evidence.originalFilename ?? null,
    mimeType: evidence.mimeType ?? null,
    fileSize: evidence.fileSize ?? null,
    sha256Hash: evidence.sha256Hash ?? null,
    hashAlgorithm: evidence.hashAlgorithm,
    encryptionStatus: evidence.encryptionStatus ?? null,
    registeredByOfficer: evidence.registeredByOfficer ?? null,
    currentCustodianDepartment: evidence.currentCustodianDepartment ?? null,
    currentCustodianOfficer: evidence.currentCustodianOfficer ?? null,
    collectedByOfficer: evidence.collectedByOfficer ?? null,
    collectingDepartment: evidence.collectingDepartment ?? null,
    committedAt: evidence.committedAt ?? null,
    createdAt: evidence.createdAt,
  };
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Registration (spec §38/§39)
// ------------------------------------------------------------
export async function registerEvidence(params: {
  ctx: AuthContext;
  caseRow: CaseRowMinimal;
  input: EvidenceRegisterInput;
  file?: EvidenceRegisterFiles | null;
}): Promise<{ evidence: EvidenceSummaryRow; duplicateWarning: string | null }> {
  const { ctx, caseRow, input, file } = params;
  const isDigital = !!file;

  // Resolve the collecting officer (public officerId → internal id).
  let collectedByInternalId: string | null = null;
  if (input.collectedByOfficerId) {
    const officer = await db.officer.findFirst({
      where: { OR: [{ id: input.collectedByOfficerId }, { officerId: input.collectedByOfficerId }] },
      select: { id: true, departmentId: true },
    });
    if (!officer) throw new ApiError(404, "NOT_FOUND", "Collecting officer not found.");
    collectedByInternalId = officer.id;
  }

  // Custody rule (spec §17): the registering custodian department
  // becomes the first custodian — never a client-supplied value.
  const custodianDepartmentId = ctx.officer.departmentId;

  // ---------- DIGITAL pipeline (staged; no row until commit) ----------
  let staged: {
    storageKey: string;
    sha256Hash: string;
    keyReference: string;
    validated: { originalFilename: string; mimeType: string; fileExtension: string; fileSize: number };
    quarantined: boolean;
    scanReason: string | null;
  } | null = null;

  if (isDigital && file) {
    // Stage 1 — validate (spec §13/§14 reuse): extension + declared MIME +
    // magic bytes + size, never trusting the client declaration. Evidence
    // profile widens formats (mp4/zip/raw images) per spec §11.
    const validated = validateUploadedFile({
      originalFilename: file.originalFilename,
      declaredMimeType: file.declaredMimeType,
      buffer: file.buffer,
      allowedExtensions: EVIDENCE_ALLOWED_EXTENSIONS,
      allowRawDiskImage: true,
    });

    // Stage 2 — security scan (DEVELOPMENT STUB, labeled in scanner.ts).
    const scan = scanFileContent(file.buffer, validated.mimeType);
    if (scan.verdict === "MALICIOUS") {
      await recordAuditEvent({
        eventType: "EVIDENCE_CREATED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        result: "FAILED",
        sessionId: ctx.sessionId,
        metadata: { reason: "security scan rejected file", filename: validated.originalFilename.slice(0, 100) },
      });
      throw new ApiError(422, "FILE_SCAN_FAILED", "The file was rejected by the security scanner.");
    }

    // Stage 3 — SHA-256 integrity fingerprint over PLAINTEXT (spec §13).
    const sha256Hash = calculateSha256(file.buffer);

    // Duplicate awareness — warn only, never block (hash is not an identifier).
    const duplicate = await db.evidence.findFirst({
      where: { caseId: caseRow.id, sha256Hash, hasDigitalContent: true },
      select: { evidenceId: true },
    });

    // Stage 4 — encrypt + store via the Phase 3 storage abstraction (spec §12).
    const { blob, keyReference } = encryptDocument(file.buffer);
    const evidenceUuid = randomUUID();
    const storageKey = buildEvidenceStorageKey(caseRow.id, evidenceUuid);
    try {
      DocumentStorage.ensureRoot();
      await DocumentStorage.put_object(storageKey, blob);
    } catch (err) {
      console.error("[evidence-service] storage failure", err);
      throw new ApiError(503, "INTERNAL_ERROR", "Secure storage is temporarily unavailable. The evidence was not registered.");
    }

    staged = {
      storageKey,
      sha256Hash,
      keyReference,
      validated,
      quarantined: scan.verdict === "SUSPICIOUS",
      scanReason: scan.verdict === "SUSPICIOUS" ? scan.reason ?? "flagged by scanner" : null,
    };

    if (duplicate) {
      return await commitEvidence(params, staged, collectedByInternalId, custodianDepartmentId, duplicate.evidenceId);
    }
    return await commitEvidence(params, staged, collectedByInternalId, custodianDepartmentId, null);
  }

  // ---------- PHYSICAL path ----------
  return await commitEvidence(params, null, collectedByInternalId, custodianDepartmentId, null);
}

async function commitEvidence(
  params: {
    ctx: AuthContext;
    caseRow: CaseRowMinimal;
    input: EvidenceRegisterInput;
  },
  staged: {
    storageKey: string;
    sha256Hash: string;
    keyReference: string;
    validated: { originalFilename: string; mimeType: string; fileExtension: string; fileSize: number };
    quarantined: boolean;
    scanReason: string | null;
  } | null,
  collectedByInternalId: string | null,
  custodianDepartmentId: string,
  duplicateWarning: string | null
) {
  const { ctx, caseRow, input } = params;

  try {
    const evidence = await db.$transaction(async (tx) => {
      const geo = await tx.case.findUniqueOrThrow({
        where: { id: caseRow.id },
        select: { state: { select: { code: true } }, district: { select: { code: true } } },
      });
      const publicId = await generateEvidenceId(
        { state: { code: geo.state.code }, district: { code: geo.district.code } },
        new Date().getFullYear()
      );

      const created = await tx.evidence.create({
        data: {
          evidenceId: publicId,
          caseId: caseRow.id,
          evidenceNumber: input.evidenceNumber ?? null,
          title: input.title,
          description: input.description ?? null,
          evidenceType: input.evidenceType,
          category: input.category ?? null,
          status: "REGISTERED",
          classification: input.classification,
          sourceType: input.sourceType,
          sourceReference: input.sourceReference ?? null,
          collectionLocation: input.collectionLocation ?? null,
          collectedAt: input.collectedAt ?? null,
          receivedAt: input.receivedAt ?? null,
          condition: input.condition ?? null,
          notes: input.notes ?? null,
          deviceMetadata: input.deviceMetadata && Object.keys(input.deviceMetadata).length ? JSON.stringify(input.deviceMetadata) : null,
          collectedByOfficerId: collectedByInternalId,
          collectingDepartmentId: custodianDepartmentId,
          currentCustodianDepartmentId: custodianDepartmentId,
          currentCustodianOfficerId: ctx.officer.role === "OFFICER" || ctx.officer.role === "DEPARTMENT_ADMIN" ? ctx.officer.id : null,
          hasDigitalContent: !!staged,
          originalFilename: staged ? staged.validated.originalFilename : null,
          mimeType: staged ? staged.validated.mimeType : null,
          fileSize: staged ? staged.validated.fileSize : null,
          storageProvider: staged ? DocumentStorage.provider : null,
          storageKey: staged ? staged.storageKey : null,
          sha256Hash: staged ? staged.sha256Hash : null,
          hashAlgorithm: staged ? "SHA-256" : "N/A", // physical evidence has no binary fingerprint
          encryptionStatus: staged ? "ENCRYPTED_AES_256_GCM" : null,
          keyReference: staged ? staged.keyReference : null,
          registeredByOfficerId: ctx.officer.id,
          registeredByDepartmentId: ctx.officer.departmentId,
          committedAt: new Date(),
        },
        select: SUMMARY_SELECT,
      }) as EvidenceSummaryRow;

      // Initial custody record + audit events IN THE SAME TRANSACTION
      // (spec §39: commit → custody record → audit event; §48/§49:
      // atomic audit). If audit fails, registration rolls back.
      await appendAuditEvent(
        {
          eventType: "EVIDENCE_CREATED",
          actorOfficerId: ctx.officer.id,
          actorDepartmentId: ctx.officer.departmentId,
          caseId: caseRow.caseId,
          evidenceId: created.evidenceId,
          sessionId: ctx.sessionId,
          result: staged?.quarantined ? "FAILED" : "SUCCESS",
          metadata: {
            evidenceId: created.evidenceId,
            title: created.title.slice(0, 100),
            evidenceType: created.evidenceType,
            classification: created.classification,
            hasDigitalContent: !!staged,
            sha256: staged ? staged.sha256Hash : undefined,
            quarantined: staged?.quarantined || undefined,
          },
        },
        tx
      );

      if (staged && !staged.quarantined) {
        await appendAuditEvent(
          {
            eventType: "EVIDENCE_COMMITTED",
            actorOfficerId: ctx.officer.id,
            actorDepartmentId: ctx.officer.departmentId,
            caseId: caseRow.caseId,
            evidenceId: created.evidenceId,
            sessionId: ctx.sessionId,
            metadata: { evidenceId: created.evidenceId, sha256: staged.sha256Hash, hashAlgorithm: "SHA-256" },
          },
          tx
        );
      }

      // Case-timeline mirror (spec §36 — evidence events appear in the case view).
      await recordCaseEvent(
        {
          eventType: "EVIDENCE_REGISTERED" as CaseEventType,
          caseId: caseRow.id,
          actorOfficerId: ctx.officer.id,
          departmentId: ctx.officer.departmentId,
          targetType: "EVIDENCE",
          targetId: created.evidenceId,
          description: `Evidence registered: ${created.title} (${created.evidenceId})`,
          metadata: { evidenceId: created.evidenceId, evidenceType: created.evidenceType, hasDigitalContent: !!staged },
        },
        tx
      );

      return created;
    });

    return { evidence, duplicateWarning };
  } catch (err) {
    // Metadata persistence failed AFTER object storage: clean up the
    // orphaned object — no partial commits (spec §11/§39 + Phase 3 §22).
    if (staged) {
      DocumentStorage.delete_staged_object(staged.storageKey);
    }
    if (err instanceof ApiError) throw err;
    console.error("[evidence-service] commit failure — orphan cleanup executed", err);
    throw new ApiError(500, "INTERNAL_ERROR", "Evidence registration failed. Nothing was recorded.");
  }
}

// ------------------------------------------------------------
// Controlled status change (spec §8) — transition map enforced,
// TRANSFER_PENDING is service-managed and rejected here.
// ------------------------------------------------------------
export async function changeEvidenceStatus(params: {
  ctx: AuthContext;
  caseRow: CaseRowMinimal;
  evidence: { id: string; evidenceId: string; status: string; title: string };
  requestedStatus: string;
  reason?: string | null;
}): Promise<EvidenceSummaryRow> {
  const { ctx, caseRow, evidence, requestedStatus } = params;

  const updated = await db.$transaction(async (tx) => {
    const current = await tx.evidence.findUnique({ where: { id: evidence.id }, select: { status: true, version: true, title: true } });
    if (!current) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found.");

    const { EVIDENCE_STATUS_TRANSITIONS } = await import("@/lib/constants");
    const allowed = EVIDENCE_STATUS_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(requestedStatus)) {
      throw new ApiError(
        422,
        "INVALID_EVIDENCE_TRANSITION",
        `Status change ${current.status} → ${requestedStatus} is not permitted. Allowed: ${allowed.length ? allowed.join(", ") : "none (terminal status)"}.`
      );
    }

    const now = new Date();
    // Guarded flip: status must still be what we validated (no racing transfer).
    const flipped = await tx.evidence.updateMany({
      where: { id: evidence.id, status: current.status, version: current.version },
      data: { status: requestedStatus, version: { increment: 1 }, updatedAt: now },
    });
    if (flipped.count === 0) {
      throw new ApiError(409, "CONCURRENCY_CONFLICT", "Evidence was modified concurrently. Please retry.");
    }

    await appendAuditEvent(
      {
        eventType: "EVIDENCE_STATUS_CHANGED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        evidenceId: evidence.evidenceId,
        sessionId: ctx.sessionId,
        metadata: { evidenceId: evidence.evidenceId, from: current.status, to: requestedStatus, reason: params.reason?.slice(0, 200) || undefined },
      },
      tx
    );

    await recordCaseEvent(
      {
        eventType: "EVIDENCE_UPDATED" as CaseEventType,
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        departmentId: ctx.officer.departmentId,
        targetType: "EVIDENCE",
        targetId: evidence.evidenceId,
        description: `Evidence ${evidence.evidenceId} status changed ${current.status} → ${requestedStatus}`,
        metadata: { evidenceId: evidence.evidenceId, from: current.status, to: requestedStatus },
      },
      tx
    );

    return tx.evidence.findUniqueOrThrow({ where: { id: evidence.id }, select: SUMMARY_SELECT }) as Promise<EvidenceSummaryRow>;
  });

  return updated;
}

// ------------------------------------------------------------
// Controlled integrity verification — SYSTEM_ADMIN backend process
// (spec §13/§40): recomputes SHA-256 over decrypted content and
// compares to the frozen fingerprint. NOT a user-facing badge.
// ------------------------------------------------------------
export async function verifyEvidenceIntegrity(params: {
  ctx: AuthContext;
  caseRow: CaseRowMinimal;
  evidence: { id: string; evidenceId: string; storageKey: string | null; sha256Hash: string | null; hasDigitalContent: boolean };
}): Promise<{ match: boolean; recordedHash: string | null; computedHash: string | null; hasDigitalContent: boolean }> {
  const { ctx, caseRow, evidence } = params;

  if (!evidence.hasDigitalContent || !evidence.storageKey || !evidence.sha256Hash) {
    return { match: true, recordedHash: null, computedHash: null, hasDigitalContent: false };
  }

  let result: { match: boolean; recordedHash: string; computedHash: string };
  try {
    const stored = await DocumentStorage.get_object(evidence.storageKey);
    const plaintext = decryptDocument(stored);
    result = verifyHash(plaintext, evidence.sha256Hash);
  } catch (err) {
    console.error("[evidence-integrity] verification error", evidence.evidenceId, err);
    result = { match: false, recordedHash: evidence.sha256Hash, computedHash: "VERIFICATION_ERROR" };
  }

  await recordAuditEvent({
    eventType: "EVIDENCE_INTEGRITY_VERIFIED",
    actorOfficerId: ctx.officer.id,
    actorDepartmentId: ctx.officer.departmentId,
    caseId: caseRow.caseId,
    evidenceId: evidence.evidenceId,
    sessionId: ctx.sessionId,
    result: result.match ? "SUCCESS" : "FAILED",
    metadata: { evidenceId: evidence.evidenceId, match: result.match },
  });

  return { ...result, hasDigitalContent: true };
}
