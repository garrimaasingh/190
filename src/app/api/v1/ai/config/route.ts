import { z } from "zod";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requireAIAccess } from "@/lib/ai/authorization";
import { getAIConfig, setAIConfig } from "@/lib/ai/config";
import { appendAuditEvent } from "@/lib/audit/service";
import { roleHas, PERMISSIONS } from "@/lib/permissions";
import { AI_LLM_PROVIDERS } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/ai/config — read current configuration (any AI user).
// Includes the transparency fields (spec §38): provider, model,
// processing mode.
export async function GET(req: Request) {
  try {
    await requireAIAccess(req);
    const config = await getAIConfig();
    return jsonOk({
      config,
      transparency: {
        processingMode: config.localOnly ? "LOCAL_ONLY" : "EXTERNAL_ALLOWED",
        activeLLM: config.localOnly ? "heuristic (local)" : config.llmProvider,
        externalProviderNote:
          "The platform makes no claim that any external AI provider is government-approved, legally compliant, or court-approved.",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  localOnly: z.boolean().optional(),
  llmProvider: z.enum(AI_LLM_PROVIDERS).optional(),
  ocrProvider: z.string().max(40).optional(),
  embeddingProvider: z.string().max(40).optional(),
  maxContextChars: z.number().int().min(1000).max(200_000).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(8).optional(),
  classificationConfidenceThreshold: z.number().min(0).max(1).optional(),
  qaRetrievalThreshold: z.number().min(0).max(1).optional(),
  autoProcessOnCommit: z.boolean().optional(),
});

// PUT /api/v1/ai/config (spec §56) — administrative configuration.
// Requires AI_CONFIGURE (SYSTEM_ADMIN). Every change is audited
// (AI_CONFIG_CHANGED) with a field-level diff.
export async function PUT(req: Request) {
  try {
    const { ctx } = await requireAIAccess(req);
    if (!roleHas(ctx.officer.role, PERMISSIONS.AI_CONFIGURE)) {
      throw new ApiError(403, "FORBIDDEN", "Only platform administrators may change AI configuration.");
    }
    const patch = patchSchema.parse(await req.json());
    if (patch.llmProvider && patch.llmProvider !== "heuristic" && patch.localOnly !== false) {
      throw new ApiError(422, "VALIDATION_ERROR", "Enabling an external provider requires disabling LOCAL_ONLY mode in the same change.");
    }
    const before = await getAIConfig();
    const after = await setAIConfig(patch, ctx.officer.id);
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        diff[key] = { from: before[key], to: after[key] };
      }
    }
    await appendAuditEvent({
      eventType: "AI_CONFIG_CHANGED",
      actorOfficerId: ctx.officer.id,
      actorDepartmentId: ctx.officer.departmentId,
      sessionId: ctx.sessionId,
      metadata: { changedFields: Object.keys(diff), diff },
    });
    return jsonOk({ config: after });
  } catch (err) {
    return handleApiError(err);
  }
}
