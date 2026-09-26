import type { IntegrationProvider } from "./provider";
import {
  MockCCTNSProvider,
  MockECourtsProvider,
  MockEForensicsProvider,
  MockEPrisonsProvider,
  MockEProsecutionProvider,
  MockICJSProvider,
} from "./providers";

// ============================================================
// Phase 8 — Provider registry (spec §2/§49).
//
// The ONLY place provider construction happens. Core services and
// API routes resolve providers exclusively through this registry —
// provider-specific logic never leaks into the application.
//
// REALITY (spec §75 W/X): every registered provider is a MOCK.
// When a verified government interface + credentials exist, a REAL
// provider class implementing IntegrationProvider registers here
// and the connection row flips providerMode to SANDBOX/REAL.
// ============================================================

type ProviderFactory = () => IntegrationProvider;

const REGISTRY: Record<string, ProviderFactory> = {
  CCTNS: () => new MockCCTNSProvider(),
  E_FORENSICS: () => new MockEForensicsProvider(),
  E_PROSECUTION: () => new MockEProsecutionProvider(),
  E_COURTS: () => new MockECourtsProvider(),
  E_PRISONS: () => new MockEPrisonsProvider(),
  ICJS: () => new MockICJSProvider(),
};

export function listRegisteredProviderTypes(): string[] {
  return Object.keys(REGISTRY);
}

export function hasProvider(providerType: string): boolean {
  return providerType in REGISTRY;
}

/**
 * Fresh provider instance per call — providers hold NO connection
 * state of their own (simulation state lives in module-scoped maps
 * keyed by connection id inside the mock family).
 */
export function getProvider(providerType: string): IntegrationProvider | null {
  const factory = REGISTRY[providerType];
  return factory ? factory() : null;
}

export function getProviderOrThrow(providerType: string): IntegrationProvider {
  const provider = getProvider(providerType);
  if (!provider) throw new Error(`PROVIDER_NOT_REGISTERED:${providerType}`);
  return provider;
}
