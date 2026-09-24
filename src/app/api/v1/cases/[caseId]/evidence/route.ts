import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { evidenceRegisterSchema, evidenceListQuerySchema } from "@/lib/validation";
import { EVIDENCE_CLASSIFICATIONS, DOCUMENT_CLASSIFICATION_LEVEL, DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES } from "@/lib/constants";
import { canRegisterEvidence } from "@/lib/evidence/authorization";
import { registerEvidence, toEvidenceSummary, type EvidenceRegisterInput, type EvidenceSummaryRow } from "@/lib/evidence/service";
import { recordAuditEvent } from "@/lib/audit/service";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/evidence — register evidence (spec §38/
// §39). multipart/form-data WITH a `file` field registers digital
// evidence (full hash→encrypt→store→commit pipeline); without a
// file it registers physical evidence (metadata-only commit).
// The server derives registrar identity, custodian and integrity
// fields — those are never accepted from the client (spec §5/§13).
// ============================================================

const FORM_FIELDS = [
  "title",
  "description",
  "evidenceType",
  "category",
  "classification",
  "sourceType",
  "sourceReference",
  "collectionLocation",
  "collectedAt",
  "collectedByOfficerId",
  "condition",
  "notes",
  "evidenceNumber",
  "deviceMetadata",
] as const;

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_MANAGE);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    // Case-level check first: no case access → case error, never an
    // evidence-level message (spec §19/§47).
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, "multipart/form-data body is required.");
    }

    const raw: Record<string, unknown> = {};
    for (const key of FORM_FIELDS) {
      const value = form.get(key);
      if (typeof value === "string" && value !== "") {
        if (key === "collectedAt") {
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) {
            throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Collection date/time is invalid.");
          }
          raw[key] = d;
        } else if (key === "deviceMetadata") {
          // Optional acquisition metadata (spec §10): parsed and bounded
          // by the schema; never claimed available for every type.
          try {
            raw[key] = JSON.parse(value);
          } catch {
            throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "deviceMetadata must be valid JSON.");
          }
        } else {
          raw[key] = value;
        }
      }
    }
    const input = evidenceRegisterSchema.parse(raw) as unknown as EvidenceRegisterInput;

    // Case status gate + custody rule + classification ceiling (spec §19).
    const gate = canRegisterEvidence(ctx, access, caseRow.status, input.classification);
    if (!gate.allowed) {
      await recordAuditEvent({
        eventType: "EVIDENCE_ACCESS_DENIED",
        actorOfficerId: ctx.officer.id,
        actorDepartmentId: ctx.officer.departmentId,
        caseId: caseRow.caseId,
        sessionId: ctx.sessionId,
        result: "DENIED",
        metadata: { reason: gate.reason || "evidence registration not permitted", action: "register" },
      });
      throw new ApiError(403, ERROR_CODES.EVIDENCE_ACCESS_DENIED, gate.reason || "Evidence registration not permitted.");
    }

    const file = form.get("file");
    let filePayload: { buffer: Buffer; originalFilename: string; declaredMimeType: string | null | undefined } | null = null;
    if (file instanceof File) {
      filePayload = {
        buffer: Buffer.from(await file.arrayBuffer()),
        originalFilename: file.name,
        declaredMimeType: file.type,
      };
    }

    const { evidence, duplicateWarning } = await registerEvidence({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      input,
      file: filePayload,
    });

    return jsonOk(
      {
        evidence: toEvidenceSummary(evidence, caseRow.caseId),
        duplicateWarning, // e.g. "EVD-MP-IND-2026-000001" — warn only (spec §67 analog)
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// ============================================================
// GET /api/v1/cases/{caseId}/evidence — clearance-filtered search
// (spec §37/§19). Rows the viewer cannot see (classification above
// clearance) are excluded IN THE QUERY — never fetch-then-filter.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.EVIDENCE_READ);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const url = new URL(req.url);
    const query = evidenceListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    // Classification clearance → the exact set of visible values (spec §19).
    const role = ctx.officer.role;
    let clearance: number;
    if (role === "SYSTEM_ADMIN") clearance = 4;
    else if (role === "AUDITOR") clearance = 3;
    else if (access.isCustodianSide) clearance = role === "OFFICER" && !access.assigned ? 2 : 4;
    else if (access.assigned) clearance = 2;
    else clearance = 1;
    const visibleClassifications = EVIDENCE_CLASSIFICATIONS.filter(
      (c) => (DOCUMENT_CLASSIFICATION_LEVEL[c] ?? 99) <= clearance
    );

    const where = {
      caseId: caseRow.id,
      // Clearance filter (spec §19/§64 analog): visible classifications
      // at CASE-level clearance, OR any item the viewer's department is
      // the CURRENT EVIDENCE CUSTODIAN of (§45: item custody ≠ case
      // custody; custodian-department staff hold the item, so they see
      // its record). The client's classification filter narrows further
      // but can never widen visibility.
      AND: [
        {
          OR: [
            { classification: { in: visibleClassifications } },
            ...(ctx.officer.role === "AUDITOR" || ctx.officer.role === "SYSTEM_ADMIN"
              ? []
              : [{ currentCustodianDepartmentId: ctx.officer.departmentId }]),
          ],
        },
        ...(query.classification ? [{ classification: query.classification }] : []),
      ],
      ...(query.type ? { evidenceType: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.custodianDepartmentId ? { currentCustodianDepartmentId: query.custodianDepartmentId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(`${query.dateTo}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q } },
              { description: { contains: query.q } },
              { evidenceId: { contains: query.q } },
              { evidenceNumber: { contains: query.q } },
              { sourceReference: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.evidence.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
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
        },
      }),
      db.evidence.count({ where }),
    ]);

    return jsonOk({
      items: rows.map((r) => toEvidenceSummary(r as EvidenceSummaryRow, caseRow.caseId)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      caseId: caseRow.caseId,
      canRegister:
        access.manage &&
        ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER"].includes(role) &&
        DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES.includes(caseRow.status),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
