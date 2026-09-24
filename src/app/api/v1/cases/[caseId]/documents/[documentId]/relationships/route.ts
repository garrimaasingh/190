import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertCaseManage } from "@/lib/cases/access";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { documentRelationshipSchema } from "@/lib/validation";
import { linkDocuments } from "@/lib/documents/service";
import { ERROR_CODES } from "@/lib/constants";

export const runtime = "nodejs";

// ============================================================
// GET /api/v1/cases/{caseId}/documents/{documentId}/relationships
// Relationship graph for this document (spec §9/§40) — both
// directions, with counterpart summaries.
// ============================================================

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    const rels = await db.documentRelationship.findMany({
      where: { OR: [{ sourceDocumentId: doc.id }, { targetDocumentId: doc.id }] },
      orderBy: { createdAt: "asc" },
      include: {
        sourceDocument: { select: { documentId: true, title: true, classification: true, status: true, documentType: true } },
        targetDocument: { select: { documentId: true, title: true, classification: true, status: true, documentType: true } },
      },
    });

    return jsonOk({
      documentId: doc.documentId,
      relationships: rels.map((r) => ({
        id: r.id,
        relationshipType: r.relationshipType,
        direction: r.sourceDocumentId === doc.id ? ("outgoing" as const) : ("incoming" as const),
        counterpart: r.sourceDocumentId === doc.id ? r.targetDocument : r.sourceDocument,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// ============================================================
// POST — create a RELATED/REFERENCE link between two existing
// documents (spec §9/§77/§79). SUPPLEMENT/CORRECTION/REPLACEMENT
// relationships are NOT accepted here: they are created only by
// their dedicated workflows, which commit a new document first.
// ============================================================

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_UPLOAD);
    const { caseId, documentId } = await params;
    const { caseRow, access, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    // Relationship creation is a custodian-authority operation (spec §77).
    await assertCaseManage(ctx, caseRefOf(caseRow.caseId));

    const body = await req.json().catch(() => ({}));
    const { targetDocumentId, relationshipType } = documentRelationshipSchema.parse(body);

    const target = await db.caseDocument.findFirst({
      where: { OR: [{ documentId: targetDocumentId }, { id: targetDocumentId }], caseId: caseRow.id },
      select: { id: true, documentId: true, classification: true, status: true },
    });
    if (!target) {
      throw new ApiError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Target document not found in this case.");
    }
    if (target.status === "QUARANTINED") {
      throw new ApiError(422, ERROR_CODES.INVALID_RELATIONSHIP, "Quarantined documents cannot be linked.");
    }

    const result = await linkDocuments({
      ctx,
      access,
      caseId: caseRow.id,
      source: { id: doc.id, documentId: doc.documentId, classification: doc.classification },
      target: { id: target.id, documentId: target.documentId, classification: target.classification },
      relationshipType,
    });
    return jsonOk({ relationshipId: result.relationshipId, relationshipType }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

function caseRefOf(casePublicId: string): string {
  return casePublicId;
}
