import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopExportService } from "@/lib/interop/export-service";

export const runtime = "nodejs";

// GET /api/v1/interoperability/exports/preview?caseRef=… — authorized
// export scope preview (§56 step 4/6): shows EXACTLY which documents,
// evidence and relationships would be included, and which are
// excluded (clearance) — before anything is packaged.
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.INTEROP_EXPORT);
    const caseRef = new URL(req.url).searchParams.get("caseRef");
    if (!caseRef) throw new ApiError(422, "VALIDATION_ERROR", "caseRef is required.");
    return jsonOk(await interopExportService.preview(ctx, caseRef));
  } catch (err) {
    return handleApiError(err);
  }
}
