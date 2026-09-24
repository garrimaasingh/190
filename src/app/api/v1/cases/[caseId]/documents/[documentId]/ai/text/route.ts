import { z } from "zod";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAIAccess, assertDocumentAIAccess } from "@/lib/ai/authorization";
import { assertDocumentViewable } from "@/lib/documents/routing";
import { appendAuditEvent } from "@/lib/audit/service";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/cases/{caseId}/documents/{documentId}/ai/text
// Normalized text pages (spec §9) — derived data with per-page
// provenance: sourceType NATIVE_TEXT|OCR|MANUAL_CORRECTION.
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    const { caseId, documentId } = await params;
    const { doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    const rows = await db.documentText.findMany({ where: { documentId: doc.id }, orderBy: { pageNumber: "asc" } });
    return jsonOk({
      pages: rows.map((t) => ({
        pageNumber: t.pageNumber,
        text: t.text,
        language: t.language,
        languageConfidence: t.languageConfidence,
        sourceType: t.sourceType,
        sourceReference: t.sourceReference,
        extractionConfidence: t.extractionConfidence,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const correctionSchema = z.object({
  pageNumber: z.number().int().min(0).max(10000),
  text: z.string().min(1).max(200_000),
  sectionIdentifier: z.string().max(120).optional(),
});

// POST /api/v1/cases/{caseId}/documents/{documentId}/ai/text
// MANUAL CORRECTION (spec §9/§41): creates corrected DERIVED text —
// the original document object and its SHA-256 are NEVER touched.
// The superseded text is snapshotted into AIResultVersion first.
export async function POST(req: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const { ctx } = await requireAIAccess(req);
    if (!roleHas(ctx.officer.role, PERMISSIONS.AI_REVIEW)) {
      throw new ApiError(403, "AI_REVIEW_NOT_ALLOWED", "Only reviewers may correct derived text.");
    }
    const { caseId, documentId } = await params;
    const { caseRow, doc } = await assertDocumentViewable(ctx, caseId, documentId, "view");
    const body = correctionSchema.parse(await req.json());

    const previous = await db.documentText.findUnique({
      where: { documentId_pageNumber: { documentId: doc.id, pageNumber: body.pageNumber } },
    });
    if (previous) {
      const versionCount = await db.aIResultVersion.count({ where: { resultType: "DOCUMENT_TEXT", sourceInternalId: previous.id } });
      await db.aIResultVersion.create({
        data: {
          resultType: "DOCUMENT_TEXT",
          sourceRef: doc.documentId,
          sourceInternalId: previous.id,
          versionNumber: versionCount + 1,
          modelProvider: previous.sourceType === "OCR" ? "tesseract" : previous.sourceType.toLowerCase(),
          modelName: previous.sourceReference || previous.sourceType,
          inputReference: doc.sha256Hash.slice(0, 16),
          outputReference: JSON.stringify({ text: previous.text.slice(0, 2000), sourceType: previous.sourceType }),
        },
      });
    }
    await db.documentText.upsert({
      where: { documentId_pageNumber: { documentId: doc.id, pageNumber: body.pageNumber } },
      create: {
        documentId: doc.id,
        pageNumber: body.pageNumber,
        text: body.text,
        sourceType: "MANUAL_CORRECTION",
        sourceReference: `officer:${ctx.officer.officerId}`,
        extractionConfidence: 1,
      },
      update: {
        text: body.text,
        sourceType: "MANUAL_CORRECTION",
        sourceReference: `officer:${ctx.officer.officerId}`,
        extractionConfidence: 1,
        sectionIdentifier: body.sectionIdentifier ?? null,
      },
    });

    await appendAuditEvent({
      eventType: "AI_TEXT_CORRECTED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      caseId: caseRow.caseId,
      documentId: doc.documentId,
      sessionId: ctx.sessionId,
      metadata: { pageNumber: body.pageNumber, previousLength: previous?.text.length ?? 0, newLength: body.text.length },
    });

    return jsonOk({ message: "Derived text corrected. The original document is unchanged." }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
