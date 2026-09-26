"use client";

import * as React from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState, LoadingState } from "@/components/platform/common";
import { Plug, PlugZap, RefreshCw, ShieldCheck, FlaskConical, Search, Download, Upload, Activity, CheckCircle2, XCircle } from "lucide-react";

// ============================================================
// Phase 8 UI (spec §40/§41/§71):
//  - /integrations dashboard: connections with HEALTH, environment
//    and PROVIDER MODE prominently displayed — MOCK/SANDBOX/REAL is
//    never hidden (§71).
//  - Provider detail: capabilities (§4), actions (test/sync/search &
//    import/export), recent jobs and conflicts.
// The UI respects CAPABILITIES: unsupported operations are not
// offered. No secrets are ever displayed.
// ============================================================

export interface IntegrationConnection {
  connectionId: string;
  providerType: string;
  providerMode: string;
  displayName: string;
  environment: string;
  status: string;
  scope: string;
  allowedOperations: string[];
  capabilities: Record<string, boolean> | null;
  enabled: boolean;
  health: {
    lastCheckAt: string | null;
    lastStatus: string | null;
    lastLatencyMs: number | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorCategory: string | null;
  };
  ownerDepartment?: { code: string; name: string };
}

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    CONNECTED: "bg-emerald-100 text-emerald-800",
    ERROR: "bg-red-100 text-red-800",
    DISABLED: "bg-gray-200 text-gray-700",
    CONFIGURED: "bg-blue-100 text-blue-800",
    DISCONNECTED: "bg-amber-100 text-amber-800",
  };
  return map[status] || "bg-gray-100 text-gray-700";
};

/** §71 — the provider mode badge is LOUD: MOCK is never disguised. */
export function ProviderModeBadge({ mode }: { mode: string }) {
  if (mode === "MOCK") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-fuchsia-100 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-fuchsia-800 border border-fuchsia-300">
        <FlaskConical size={11} aria-hidden /> MOCK
      </span>
    );
  }
  if (mode === "SANDBOX") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-800 border border-amber-300">
        SANDBOX
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-800 border border-emerald-300">
      REAL
    </span>
  );
}

export function IntegrationsView({ onOpenConnection }: { onOpenConnection: (connectionId: string) => void }) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<{ items: IntegrationConnection[]; summary: { total: number; connected: number; pendingImports: number; pendingExports: number; openConflicts: number }; registeredProviderTypes: string[] } | null>(null);

  async function load() {
    setError(null);
    try {
      setData(await api.get("/api/v1/integrations"));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load integrations.");
    } finally {
      setLoading(false);
    }
  }
  React.useEffect(() => { void load(); }, []);

  if (loading) return <LoadingState label="Loading integrations…" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inter-Department Integration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Controlled exchange with external departmental systems. This platform does <strong>not</strong> replace
          CCTNS / ICJS / e-Forensics / e-Prosecution / e-Courts / e-Prisons — every connection below is an
          adapter boundary, and its provider mode is stated explicitly.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "Connections", value: data.summary.total },
          { label: "Connected", value: data.summary.connected },
          { label: "Pending imports", value: data.summary.pendingImports },
          { label: "Pending exports", value: data.summary.pendingExports },
          { label: "Open conflicts", value: data.summary.openConflicts },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-5">
              <div className="text-2xl font-semibold">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.items.map((c) => (
          <Card key={c.connectionId} className="cursor-pointer transition-shadow hover:shadow-md" onClick={() => onOpenConnection(c.connectionId)}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Plug size={16} aria-hidden className="text-muted-foreground" />
                    {c.displayName}
                  </CardTitle>
                  <CardDescription className="mt-1 font-mono text-xs">{c.connectionId}</CardDescription>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <ProviderModeBadge mode={c.providerMode} />
                  <Badge variant="outline" className="text-[11px]">{c.environment}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${statusBadge(c.status)}`}>
                  {c.status === "CONNECTED" ? <CheckCircle2 size={12} aria-hidden /> : c.status === "ERROR" ? <XCircle size={12} aria-hidden /> : null}
                  {c.status}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Owner</span>
                <span>{c.ownerDepartment?.name ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last health check</span>
                <span className="text-xs">
                  {c.health.lastCheckAt ? `${c.health.lastStatus ?? "—"} · ${c.health.lastLatencyMs ?? "—"} ms` : "never"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Operations</span>
                <span className="font-mono text-xs">{c.allowedOperations.join(", ")}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Provider detail view (§41)
// ============================================================

interface CapabilitiesResponse {
  connectionId: string;
  providerType: string;
  providerMode: string;
  capabilities: Record<string, boolean>;
  detailed: Record<string, { enabled: boolean; description: string }>;
  minPollingIntervalMinutes: number;
  supportedSchemaVersions: string[];
}

interface ConnectionDetail {
  connection: IntegrationConnection & {
    authenticationType: string;
    hasWebhookSecret: boolean;
    baseUrlReference: string | null;
    health: IntegrationConnection["health"] & { consecutiveFailures: number };
  };
  recentImports: Array<{ jobId: string; status: string; importType: string; recordsReceived: number; recordsImported: number; recordsRejected: number; recordsConflicted: number; createdAt: string }>;
  recentExports: Array<{ jobId: string; status: string; exportType: string; recordsSelected: number; recordsExported: number; recordsFailed: number; createdAt: string }>;
  recentConflicts: Array<{ conflictId: string; fieldName: string; status: string; caseRef: string | null; createdAt: string }>;
}

export interface ExternalSearchResult {
  items: Array<{ externalCaseId: string; externalCaseNumber?: string | null; title: string; caseType?: string | null; status?: string | null; updatedAt?: string | null }>;
  providerMode: string;
  environment: string;
}

export function IntegrationDetailView({ connectionId, onBack }: { connectionId: string; onBack: () => void }) {
  const [detail, setDetail] = React.useState<ConnectionDetail | null>(null);
  const [caps, setCaps] = React.useState<CapabilitiesResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQ, setSearchQ] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<ExternalSearchResult | null>(null);
  const [importCaseId, setImportCaseId] = React.useState("");
  const [importMode, setImportMode] = React.useState<"CASE" | "CASE_BUNDLE">("CASE");
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportCaseRef, setExportCaseRef] = React.useState("");
  const [exportPreview, setExportPreview] = React.useState<{ items: Array<{ caseRef: string; authorized: boolean; reason?: string | null; documentCount?: number; evidenceCount?: number }> } | null>(null);

  async function load() {
    try {
      const d = await api.get<ConnectionDetail>(`/api/v1/integrations/${connectionId}`);
      setDetail(d);
      setCaps(await api.get(`/api/v1/integrations/${connectionId}/capabilities`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load connection.");
    }
  }
  React.useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [connectionId]);

  async function runAction(name: string, fn: () => Promise<void>) {
    setError(null); setNotice(null); setBusy(name);
    try { await fn(); } catch (err) {
      setError(err instanceof ApiClientError ? err.message : `${name} failed.`);
    } finally { setBusy(null); }
  }

  if (error && !detail) return <ErrorState message={error} />;
  if (!detail || !caps) return <LoadingState label="Loading connection…" />;

  const c = detail.connection;
  const capsDisabled = !c.enabled;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack}>← All integrations</Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {c.displayName}
            <ProviderModeBadge mode={c.providerMode} />
            <Badge variant="outline">{c.environment}</Badge>
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{c.connectionId} · {c.providerType} · scope {c.scope} · auth {c.authenticationType}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null || capsDisabled} onClick={() => runAction("test", async () => {
            const r = await api.post<{ outcome: string; detail?: Record<string, unknown> }>(`/api/v1/integrations/${connectionId}/test`);
            setTestResult(r.outcome);
          })}>
            <PlugZap size={14} className="mr-1" aria-hidden /> {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null || capsDisabled || !caps.capabilities.supports_polling} onClick={() => runAction("sync", async () => {
            const r = await api.post<{ synced: boolean; checked: number; linked: number; conflicts: number }>(`/api/v1/integrations/${connectionId}/sync`);
            setNotice(`Sync ${r.synced ? "completed" : "failed"} — checked ${r.checked}, linked ${r.linked}, conflicts ${r.conflicts}.`);
          })}>
            <RefreshCw size={14} className="mr-1" aria-hidden /> {busy === "sync" ? "Syncing…" : "Sync"}
          </Button>
          {caps.capabilities.can_search_cases && (
            <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={capsDisabled}><Search size={14} className="mr-1" aria-hidden /> Search & import</Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader><DialogTitle>Search external cases (provider mode: {c.providerMode})</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input placeholder="Search by id or title…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} />
                    <Button size="sm" onClick={() => runAction("search", async () => {
                      setSearchResults(await api.post<ExternalSearchResult>(`/api/v1/integrations/${connectionId}/search`, { q: searchQ }));
                    })} disabled={busy !== null}>{busy === "search" ? "…" : "Search"}</Button>
                  </div>
                  {searchResults && (
                    <div className="space-y-2">
                      {searchResults.items.length === 0 && <p className="text-sm text-muted-foreground">No external cases matched.</p>}
                      {searchResults.items.map((item) => (
                        <div key={item.externalCaseId} className="flex items-center justify-between rounded border p-2 text-sm">
                          <div>
                            <div className="font-medium">{item.title}</div>
                            <div className="font-mono text-xs text-muted-foreground">{item.externalCaseId} · {item.externalCaseNumber ?? "no number"} · {item.status ?? "—"}</div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Select value={importMode} onValueChange={(v) => setImportMode(v as "CASE" | "CASE_BUNDLE")}>
                              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {caps.capabilities.can_import_case && <SelectItem value="CASE">Import case ref</SelectItem>}
                                {caps.capabilities.can_import_case && (caps.capabilities.can_import_documents || caps.capabilities.can_import_evidence) && <SelectItem value="CASE_BUNDLE">Import full bundle</SelectItem>}
                              </SelectContent>
                            </Select>
                            <Button size="sm" variant="secondary" disabled={busy !== null || !caps.capabilities.can_import_case}
                              onClick={() => runAction("import", async () => {
                                const job = await api.post<{ jobId: string; status: string; recordsImported: number; recordsRejected: number; recordsConflicted: number; recordsSkipped: number }>(`/api/v1/integrations/${connectionId}/import`, { importType: importMode, externalCaseId: item.externalCaseId });
                                setNotice(`Import ${job.jobId}: ${job.status} — imported ${job.recordsImported}, rejected ${job.recordsRejected}, conflicted ${job.recordsConflicted}, duplicates ${job.recordsSkipped}.`);
                                await load();
                              })}>
                              <Upload size={13} className="mr-1" aria-hidden /> Import
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          )}
          {caps.capabilities.can_export_case && (
            <Dialog open={exportOpen} onOpenChange={setExportOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={capsDisabled}><Download size={14} className="mr-1" aria-hidden /> Export case</Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader><DialogTitle>Export case to {c.displayName}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="export-case">Central case ID</Label>
                    <Input id="export-case" placeholder="CASE-MP-IND-2026-…" value={exportCaseRef} onChange={(e) => setExportCaseRef(e.target.value)} />
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => runAction("preview", async () => {
                    setExportPreview(await api.post<{ items: Array<{ caseRef: string; authorized: boolean; reason?: string | null; documentCount?: number; evidenceCount?: number }> }>(`/api/v1/integrations/${connectionId}/export/preview`, { caseRefs: [exportCaseRef.trim()] }));
                  })} disabled={busy !== null || !exportCaseRef.trim()}>Preview authorization</Button>
                  {exportPreview && (
                    <div className="space-y-1 text-sm">
                      {exportPreview.items.map((i) => (
                        <div key={i.caseRef} className="flex justify-between rounded border p-2">
                          <span className="font-mono text-xs">{i.caseRef}</span>
                          <span>{i.authorized ? `authorized · ${i.documentCount ?? 0} docs · ${i.evidenceCount ?? 0} evidence` : `excluded — ${i.reason}`}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Button size="sm" disabled={busy !== null || !exportCaseRef.trim()} onClick={() => runAction("export", async () => {
                    const job = await api.post<{ jobId: string; status: string; recordsExported: number; recordsFailed: number }>(`/api/v1/integrations/${connectionId}/export`, { exportType: "CASE_PACKAGE", caseRefs: [exportCaseRef.trim()] });
                    setNotice(`Export ${job.jobId}: ${job.status} — exported ${job.recordsExported}, failed ${job.recordsFailed}.`);
                  })}>{busy === "export" ? "Exporting…" : "Create export job"}</Button>
                  <p className="text-xs text-muted-foreground">Only cases you are authorized to view are exported. Unauthorized cases are never included.</p>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 rounded border p-3 text-sm ${testResult === "SUCCESS" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900"}`}>
          <ShieldCheck size={16} aria-hidden /> Connection test: <strong>{testResult}</strong>
        </div>
      )}
      {notice && <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900"><Activity size={14} className="mr-1 inline" aria-hidden /> {notice}</div>}
      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Capabilities (§4)</CardTitle>
            <CardDescription>The UI and backend only offer what the provider declares. Schema versions: {caps.supportedSchemaVersions.join(", ")} · min polling {caps.minPollingIntervalMinutes} min.</CardDescription></CardHeader>
          <CardContent className="grid gap-1.5 text-sm sm:grid-cols-2">
            {Object.entries(caps.detailed).map(([key, v]) => (
              <div key={key} className="flex items-center gap-2">
                {v.enabled ? <CheckCircle2 size={14} className="text-emerald-600" aria-hidden /> : <XCircle size={14} className="text-gray-300" aria-hidden />}
                <span className={v.enabled ? "" : "text-muted-foreground"}>{v.description}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Health (§9)</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{c.status}{capsDisabled && " (disabled)"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Last check</span><span>{c.health.lastCheckAt ? `${c.health.lastStatus} · ${c.health.lastLatencyMs} ms` : "never"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Last success</span><span>{c.health.lastSuccessAt ? new Date(c.health.lastSuccessAt).toLocaleString() : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Last failure</span><span>{c.health.lastFailureAt ? `${new Date(c.health.lastFailureAt).toLocaleString()} (${c.health.lastErrorCategory ?? "unknown"})` : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Simulated endpoint</span><span className="font-mono text-xs">{c.baseUrlReference}</span></div>
            <p className="pt-1 text-xs text-muted-foreground">Webhook secret configured: {c.hasWebhookSecret ? "yes (never displayed)" : "no"} · credentials held in the encrypted secret store, referenced — never stored here.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Recent import jobs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {detail.recentImports.length === 0 && <p className="text-muted-foreground">No imports yet.</p>}
            {detail.recentImports.map((j) => (
              <div key={j.jobId} className="flex items-center justify-between rounded border px-2 py-1.5">
                <span className="font-mono text-xs">{j.jobId}</span>
                <span>{j.importType}</span>
                <span>{j.recordsImported}/{j.recordsReceived} ok{ j.recordsConflicted > 0 ? ` · ${j.recordsConflicted} conflicts` : ""}</span>
                <Badge className={statusBadge(j.status)} variant="secondary">{j.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Recent export jobs & conflicts</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {detail.recentExports.length === 0 && <p className="text-muted-foreground">No exports yet.</p>}
            {detail.recentExports.map((j) => (
              <div key={j.jobId} className="flex items-center justify-between rounded border px-2 py-1.5">
                <span className="font-mono text-xs">{j.jobId}</span>
                <span>{j.recordsExported}/{j.recordsSelected} ok</span>
                <Badge className={statusBadge(j.status)} variant="secondary">{j.status}</Badge>
              </div>
            ))}
            {detail.recentConflicts.length > 0 && <div className="pt-2 text-xs text-muted-foreground">Conflicts: {detail.recentConflicts.length} (review under Integration Jobs)</div>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
