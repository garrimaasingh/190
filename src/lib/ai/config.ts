import { db } from "@/lib/db";

// ============================================================
// AI runtime configuration (spec §56).
//
// Backed by the AIConfig singleton row (created lazily with safe
// defaults) with a short in-memory cache — the process is the only
// consumer. Changes go through setAIConfig() which the admin API
// wraps in authorization + an AI_CONFIG_CHANGED audit event.
//
// LOCAL_ONLY (spec §37): when true, NO case/document content may be
// sent to an external provider. The zai (external LLM) adapter
// checks this flag before every call and refuses otherwise — the
// pipeline then uses the local heuristic provider. Default: true.
// ============================================================

export interface AIRuntimeConfig {
  aiEnabled: boolean;
  localOnly: boolean;
  llmProvider: string; // heuristic | zai
  ocrProvider: string;
  embeddingProvider: string;
  maxContextChars: number;
  maxConcurrentJobs: number;
  classificationConfidenceThreshold: number;
  qaRetrievalThreshold: number;
  autoProcessOnCommit: boolean;
  allowedProviders: string[];
}

const DEFAULTS: AIRuntimeConfig = {
  aiEnabled: true,
  localOnly: true,
  llmProvider: "heuristic",
  ocrProvider: "tesseract",
  embeddingProvider: "local-hashing",
  maxContextChars: 12000,
  maxConcurrentJobs: 2,
  classificationConfidenceThreshold: 0.55,
  qaRetrievalThreshold: 0.18,
  autoProcessOnCommit: true,
  allowedProviders: ["heuristic", "tesseract", "local-hashing"],
};

let cache: { config: AIRuntimeConfig; loadedAt: number } | null = null;
const CACHE_MS = 3000;

export function invalidateAIConfigCache(): void {
  cache = null;
}

export async function getAIConfig(): Promise<AIRuntimeConfig> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.config;
  let row = await db.aIConfig.findUnique({ where: { id: "SINGLETON" } });
  if (!row) {
    row = await db.aIConfig
      .create({ data: { id: "SINGLETON" } })
      .catch(() => db.aIConfig.findUnique({ where: { id: "SINGLETON" } }));
  }
  let allowed = DEFAULTS.allowedProviders;
  if (row?.allowedProviders) {
    try {
      const parsed = JSON.parse(row.allowedProviders);
      if (Array.isArray(parsed)) allowed = parsed.map(String);
    } catch {
      // keep defaults on malformed JSON
    }
  }
  const config: AIRuntimeConfig = {
    aiEnabled: row?.aiEnabled ?? DEFAULTS.aiEnabled,
    localOnly: row?.localOnly ?? DEFAULTS.localOnly,
    llmProvider: row?.llmProvider || DEFAULTS.llmProvider,
    ocrProvider: row?.ocrProvider || DEFAULTS.ocrProvider,
    embeddingProvider: row?.embeddingProvider || DEFAULTS.embeddingProvider,
    maxContextChars: row?.maxContextChars ?? DEFAULTS.maxContextChars,
    maxConcurrentJobs: row?.maxConcurrentJobs ?? DEFAULTS.maxConcurrentJobs,
    classificationConfidenceThreshold:
      row?.classificationConfidenceThreshold ?? DEFAULTS.classificationConfidenceThreshold,
    qaRetrievalThreshold: row?.qaRetrievalThreshold ?? DEFAULTS.qaRetrievalThreshold,
    autoProcessOnCommit: row?.autoProcessOnCommit ?? DEFAULTS.autoProcessOnCommit,
    allowedProviders: allowed,
  };
  cache = { config, loadedAt: Date.now() };
  return config;
}

export async function setAIConfig(
  patch: Partial<Omit<AIRuntimeConfig, "allowedProviders">> & { allowedProviders?: string[] },
  updatedByOfficerId: string
): Promise<AIRuntimeConfig> {
  const current = await getAIConfig();
  const next = { ...current, ...patch };
  await db.aIConfig.upsert({
    where: { id: "SINGLETON" },
    create: {
      id: "SINGLETON",
      ...next,
      allowedProviders: JSON.stringify(next.allowedProviders),
      updatedByOfficerId,
    },
    update: {
      ...next,
      allowedProviders: JSON.stringify(next.allowedProviders),
      updatedByOfficerId,
    },
  });
  invalidateAIConfigCache();
  return next;
}
