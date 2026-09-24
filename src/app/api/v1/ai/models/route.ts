import { handleApiError, jsonOk } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/v1/ai/models — model registry (spec §28).
export async function GET(req: Request) {
  try {
    await requireAIAccess(req);
    const rows = await db.aIModelRegistry.findMany({ orderBy: [{ task: "asc" }, { provider: "asc" }] });
    return jsonOk({
      models: rows.map((m) => ({
        id: m.id,
        provider: m.provider,
        modelName: m.modelName,
        modelVersion: m.modelVersion,
        task: m.task,
        languageSupport: m.languageSupport ? JSON.parse(m.languageSupport) : [],
        enabled: m.enabled,
        configuration: m.configuration ? JSON.parse(m.configuration) : null,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
