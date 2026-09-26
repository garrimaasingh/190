import { MockIntegrationProvider } from "./mock-base";
import type { IntegrationCapabilities } from "../provider";
import { emptyCapabilities } from "../provider";

// ============================================================
// Phase 8 — Mock provider family (spec §5/§50/§71).
//
// Six adapter boundaries, one per target government system family.
// NONE of these connect to a real system; each is a clearly-labeled
// in-platform simulator. Capability sets DIFFER deliberately so the
// capability model is observable end-to-end (§4): e.g. e-Forensics
// handles evidence but not case import; e-Courts is read/export
// only; ICJS is search-only in this sandbox.
// ============================================================

export class MockCCTNSProvider extends MockIntegrationProvider {
  readonly providerType = "CCTNS";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    can_import_case: true,
    can_export_case: true,
    can_read_documents: true,
    can_import_documents: true,
    can_read_evidence: true,
    can_import_evidence: true,
    supports_webhooks: true,
    supports_polling: true,
    supports_batch_import: true,
    supports_acknowledgement: true,
  };
  constructor() {
    super("mock://cctns/sandbox");
  }
}

export class MockEForensicsProvider extends MockIntegrationProvider {
  readonly providerType = "E_FORENSICS";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    can_read_documents: true,
    can_read_evidence: true,
    can_import_evidence: true,
    can_export_evidence: true,
    can_export_documents: true,
    supports_polling: true,
    supports_batch_import: true,
    supports_acknowledgement: true,
  };
  constructor() {
    super("mock://eforensics/sandbox");
  }
}

export class MockEProsecutionProvider extends MockIntegrationProvider {
  readonly providerType = "E_PROSECUTION";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    can_export_case: true,
    can_read_documents: true,
    can_export_documents: true,
    supports_polling: true,
    supports_acknowledgement: true,
  };
  constructor() {
    super("mock://eprosecution/sandbox");
  }
}

export class MockECourtsProvider extends MockIntegrationProvider {
  readonly providerType = "E_COURTS";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    can_export_case: true,
    supports_polling: true,
  };
  constructor() {
    super("mock://ecourts/sandbox");
  }
}

export class MockEPrisonsProvider extends MockIntegrationProvider {
  readonly providerType = "E_PRISONS";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    supports_polling: true,
  };
  constructor() {
    super("mock://eprisons/sandbox");
  }
}

export class MockICJSProvider extends MockIntegrationProvider {
  readonly providerType = "ICJS";
  readonly capabilities: IntegrationCapabilities = {
    ...emptyCapabilities(),
    can_search_cases: true,
    can_read_case: true,
    supports_polling: true,
  };
  constructor() {
    super("mock://icjs/sandbox");
  }
}
