import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { toDocumentSummary } from "@/lib/documents/service";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId} — full metadata
// (spec §30). Storage keys, stored filenames and key references are
// NEVER returned (spec §30); the SHA-256 fingerprint is (spec §53).
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.DOCUMENT_READ);
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");

    const full = await db.caseDocument.findUniqueOrThrow({
      where: { id: doc.id },
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
        relationshipsAsSource: {
          select: {
            id: true,
            relationshipType: true,
            createdAt: true,
            targetDocument: { select: { documentId: true, title: true, classification: true, status: true, documentType: true } },
          },
        },
        relationshipsAsTarget: {
          select: {
            id: true,
            relationshipType: true,
            createdAt: true,
            sourceDocument: { select: { documentId: true, title: true, classification: true, status: true, documentType: true } },
          },
        },
      },
    });

    return jsonOk({
      document: toDocumentSummary(full, caseRow.caseId),
      case: { caseId: caseRow.caseId, status: caseRow.status },
      relationships: {
        // forward: this document → target (e.g. this is a supplement pointing at its original)
        outgoing: full.relationshipsAsSource.map((r) => ({
          id: r.id,
          relationshipType: r.relationshipType,
          direction: "outgoing" as const,
          createdAt: r.createdAt,
          document: r.targetDocument,
        })),
        // incoming: other documents point here (e.g. supplements OF this document)
        incoming: full.relationshipsAsTarget.map((r) => ({
          id: r.id,
          relationshipType: r.relationshipType,
          direction: "incoming" as const,
          createdAt: r.createdAt,
          document: r.sourceDocument,
        })),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
