import { getAIConfig } from "@/lib/ai/config";
import { HeuristicAIProvider } from "./heuristic";
import { ZaiAIProvider } from "./zai";
import type { AIProvider } from "./types";

// ============================================================
// Provider registry (spec §27/§56).
//
// resolveAIProvider() picks the configured LLM provider and falls
// back to the local heuristic provider when:
//  - the configured provider is disabled/unknown,
//  - LOCAL_ONLY blocks an external provider (spec §37),
//  - or the caller explicitly requests the local baseline.
// The fallback is a deliberate, visible decision — the job's
// resultSummary records it (spec §38 transparency).
// ============================================================

export interface ResolvedProvider {
  provider: AIProvider;
  /** Set when the configured provider could not be used and why. */
  fallbackReason?: string;
}

export async function resolveAIProvider(): Promise<ResolvedProvider> {
  const config = await getAIConfig();
  if (config.llmProvider === "zai") {
    if (config.localOnly) {
      return {
        provider: HeuristicAIProvider,
        fallbackReason: "LOCAL_ONLY mode is enabled — external provider refused; local heuristic baseline used.",
      };
    }
    return { provider: ZaiAIProvider({ localOnly: async () => (await getAIConfig()).localOnly }) };
  }
  return { provider: HeuristicAIProvider };
}

/** Deterministic local provider — used by pipelines that must never call out. */
export function localProvider(): AIProvider {
  return HeuristicAIProvider;
}

export { HeuristicAIProvider, ZaiAIProvider };
export type { AIProvider };
