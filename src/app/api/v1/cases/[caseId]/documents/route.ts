import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveCaseAccess } from "@/lib/cases/access";
import { documentUploadSchema, documentListQuerySchema } from "@/lib/validation";
import {
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_CLASSIFICATION_LEVEL,
  DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES,
} from "@/lib/constants";
import { canUploadToCase } from "@/lib/documents/authorization";
import { uploadAndCommit, toDocumentSummary, type DocumentUploadInput } from "@/lib/documents/service";
import { recordDocumentEvent } from "@/lib/documents/events";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// POST /api/v1/cases/{caseId}/documents — secure upload + commit
// (spec §11/§42/§43). multipart/form-data: file + metadata.
// Server derives uploaded_by/department/authorization — those
// fields are never accepted from the client (spec §26/§43/§72).
// ============================================================

// Only these form fields are read — anything else is ignored (mass-assignment protection).
const FORM_FIELDS = [
  "title",
  "description",
  "documentType",
  "documentCategory",
  "classification",
  "documentDate",
  "referenceNumber",
  "issuingDepartmentName",
  "externalReference",
  "tags",
  "clientRequestId",
] as const;

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_UPLOAD);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    // Case-level check first (spec §26 steps 3-4): no case access → case error,
    // never a document-level message.
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, "multipart/form-data body with a file is required.");
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(422, ERROR_CODES.INVALID_FILE, "A document file is required.");
    }

    const raw: Record<string, unknown> = {};
    for (const key of FORM_FIELDS) {
      const value = form.get(key);
      if (typeof value === "string" && value !== "") {
        if (key === "tags") {
          raw.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
        } else if (key === "documentDate") {
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) {
            throw new ApiError(422, ERROR_CODES.VALIDATION_ERROR, "Document date is invalid.");
          }
          raw.documentDate = d;
        } else {
          raw[key] = value;
        }
      }
    }
    const input = documentUploadSchema.parse(raw) as DocumentUploadInput;

    // Case status gate (spec §56/§57) + custody rule (spec §25/§55) +
    // classification ceiling (spec §7) — all server-side (spec §26).
    const gate = canUploadToCase(ctx, access, caseRow.status, input.classification);
    if (!gate.allowed) {
      await recordDocumentEvent({
        eventType: "DOCUMENT_VALIDATION_FAILED",
        caseId: caseRow.id,
        actorOfficerId: ctx.officer.id,
        actorIdentifier: ctx.officer.officerId,
        departmentId: ctx.officer.departmentId,
        sessionId: ctx.sessionId,
        result: "DENIED",
        metadata: { reason: gate.reason || "upload not permitted" },
      });
      throw new ApiError(403, ERROR_CODES.DOCUMENT_ACCESS_DENIED, gate.reason || "Upload not permitted.");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const outcome = await uploadAndCommit({
      ctx,
      caseRow: { id: caseRow.id, caseId: caseRow.caseId, status: caseRow.status },
      input,
      file: { buffer, originalFilename: file.name, declaredMimeType: file.type },
    });

    if (outcome.quarantined) {
      return jsonOk(
        {
          quarantined: true,
          duplicateWarning: outcome.duplicateWarning,
          document: toDocumentSummary(outcome.document, caseRow.caseId),
          message: "The file was flagged by the security scan and quarantined. It was NOT committed as a valid document.",
        },
        202
      );
    }

    return jsonOk(
      {
        quarantined: false,
        replayed: outcome.replayed,
        duplicateWarning: outcome.duplicateWarning, // e.g. "DOC-MP-IND-2026-000001" (spec §67 — allowed, warn only)
        document: toDocumentSummary(outcome.document, caseRow.caseId),
      },
      outcome.replayed ? 200 : 201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// ============================================================
// GET /api/v1/cases/{caseId}/documents — metadata search & filters
// (spec §29/§41/§64). Authorization happens IN THE QUERY: rows the
// viewer cannot see (classification above clearance, quarantined
// records) are excluded server-side — never fetch-then-filter.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId } = await params;
    const { caseRow, access } = await resolveCaseAccess(ctx, caseId);
    if (!access.view) {
      throw new ApiError(403, ERROR_CODES.CASE_ACCESS_DENIED, "You are not authorized to access this case.");
    }

    const url = new URL(req.url);
    const query = documentListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    // Classification clearance → the exact set of visible classification values.
    const role = ctx.officer.role;
    let clearance: number;
    if (role === "SYSTEM_ADMIN") clearance = 4;
    else if (role === "AUDITOR") clearance = 3;
    else if (access.isCustodianSide) clearance = role === "OFFICER" && !access.assigned ? 2 : 4;
    else if (access.assigned) clearance = 2;
    else clearance = 1;
    const visibleClassifications = DOCUMENT_CLASSIFICATIONS.filter(
      (c) => (DOCUMENT_CLASSIFICATION_LEVEL[c] ?? 99) <= clearance
    );

    const where = {
      caseId: caseRow.id,
      // Clearance filter is combined with (never overwritten by) the
      // client's classification filter — spec §64: the viewer can
      // never query their way into classifications above clearance.
      AND: [
        { classification: { in: visibleClassifications } },
        ...(query.classification ? [{ classification: query.classification }] : []),
      ],
      // QUARANTINED is a security state — system-administrative visibility only.
      ...(role === "SYSTEM_ADMIN"
        ? {}
        : { status: { not: "QUARANTINED" } }),
      ...(query.type ? { documentType: query.type } : {}),
      ...(query.status && role === "SYSTEM_ADMIN" ? { status: query.status } : {}),
      ...(query.departmentId ? { uploadedByDepartmentId: query.departmentId } : {}),
      ...(query.uploadedBy ? { uploadedByOfficer: { is: { officerId: query.uploadedBy } } } : {}),
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
              { originalFilename: { contains: query.q } },
              { documentId: { contains: query.q } },
              { metadata: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.caseDocument.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          documentId: true,
          title: true,
          description: true,
          documentType: true,
          documentCategory: true,
          classification: true,
          status: true,
          originalFilename: true,
          mimeType: true,
          fileExtension: true,
          fileSize: true,
          sha256Hash: true,
          encryptionStatus: true,
          documentDate: true,
          createdAt: true,
          committedAt: true,
          supersededByDocumentId: true,
          metadata: true,
          uploadedByOfficer: { select: { officerId: true, name: true } },
          uploadedByDepartment: { select: { id: true, departmentCode: true, name: true, departmentType: true } },
        },
      }),
      db.caseDocument.count({ where }),
    ]);

    return jsonOk({
      items: rows.map((r) => toDocumentSummary(r, caseRow.caseId)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      caseId: caseRow.caseId,
      canUpload:
        access.manage &&
        ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER"].includes(role) &&
        DOCUMENT_ADDITION_ALLOWED_CASE_STATUSES.includes(caseRow.status),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
