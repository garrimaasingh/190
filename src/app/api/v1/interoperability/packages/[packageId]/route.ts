import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { interopImportService } from "@/lib/interop/import-service";

export const runtime = "nodejs";

// GET /api/v1/interoperability/packages/[packageId] — package inspector
// data (§58/§81): identity, source, counts, hashes, integrity checks,
// signature status, downloads. NO payload contents before import.
export async function GET(req: Request, { params }: { params: Promise<{ packageId: string }> }) {
  try {
    await requirePermission(req, PERMISSIONS.INTEROP_READ);
    const { packageId } = await params;
    return jsonOk(await interopImportService.getPackage(packageId));
  } catch (err) {
    return handleApiError(err);
  }
}
