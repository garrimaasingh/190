"use client";

import * as React from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/platform/common";
import { CheckCircle2, XCircle, Scale, Download } from "lucide-react";

// ============================================================
// Phase 8 UI — Import review + export history (spec §42/§45):
//  - Jobs with per-record staging (validation / conflicts / errors).
//  - Conflict cards: central vs external value, sources, timestamps,
//    resolution actions (all authorized server-side).
//  - Export jobs with integrity manifest viewer (§45).
// ============================================================

const jobStatusBadge = (status: string) => {
  const map: Record<string, string> = {
    COMPLETED: "bg-emerald-100 text-emerald-800",
    PARTIAL: "bg-amber-100 text-amber-800",
    FAILED: "bg-red-100 text-red-800",
    QUEUED: "bg-blue-100 text-blue-800",
    PROCESSING: "bg-blue-100 text-blue-800",
    CANCELLED: "bg-gray-200 text-gray-700",
  };
  return map[status] || "bg-gray-100 text-gray-700";
};

interface ImportJobDetail {
  jobId: string;
  kind: "IMPORT" | "EXPORT";
  providerType: string;
  status: string;
  connection: { connectionId: string; providerType: string; providerMode: string; displayName: string };
  requestedBy: { officerId: string; name: string };
  importType?: string;
  counters?: { received: number; imported: number; rejected: number; conflicted: number; skipped: number };
  records?: Array<{
    id: string; externalRecordId: string; recordType: string; rawReference: string | null;
    validationStatus: string; validationErrors: { errors?: Array<{ field: string; code: string; message: string }>; missing?: string[] } | null;
    conflictStatus: string; processingStatus: string; errorDetails: string | null; centralRecordRef: string | null;
  }>;
  schemaVersion?: string | null;
  mappingVersion?: number | null;
  errorSummary?: string | null;
}

export function IntegrationJobsView() {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<{ imports: Array<{ jobId: string; status: string; importType: string; recordsReceived: number; recordsImported: number; recordsRejected: number; recordsConflicted: number; recordsSkipped: number; createdAt: string; connection: { connectionId: string; providerType: string; providerMode: string; displayName: string } }>; exports: Array<{ jobId: string; status: string; exportType: string; recordsSelected: number; recordsExported: number; recordsFailed: number; createdAt: string; connection: { connectionId: string; providerType: string; providerMode: string; displayName: string } }> } | null>(null);
  const [selected, setSelected] = React.useState<ImportJobDetail | null>(null);
  const [conflicts, setConflicts] = React.useState<Array<{ conflictId: string; status: string; fieldName: string; caseRef: string | null; centralValue: string | null; externalValue: string | null; centralSource: string; externalSource: string; createdAt: string; providerType: string }>>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [manifest, setManifest] = React.useState<{ jobId: string; manifest: { algorithm: string; entries: Array<{ documentId: string; filename: string; sha256: string; size: number; mimeType: string; exportedAt: string; exportJobId: string }> }; case: { caseId: string } } | null>(null);

  async function load() {
    try {
      setJobs(await api.get("/api/v1/integrations/jobs"));
      const cf = await api.get<{ items: Array<never> }>("/api/v1/integrations/conflicts?pageSize=50");
      setConflicts(cf.items as never);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load jobs.");
    } finally {
      setLoading(false);
    }
  }
  React.useEffect(() => { void load(); }, []);

  if (loading) return <LoadingState label="Loading integration jobs…" />;
  if (error) return <ErrorState message={error} />;
  if (!jobs) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integration Jobs & Conflict Review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Imported records are staged and validated before they touch central data. Conflicts never resolve
          themselves — every resolution here is an explicit, authorized, audited decision (spec §15/§22).
        </p>
      </div>

      {notice && <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Open conflicts</CardTitle>
          <CardDescription>Central values are never silently overwritten by external systems.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {conflicts.filter((c) => c.status === "OPEN").length === 0 && <p className="text-sm text-muted-foreground">No open conflicts.</p>}
          {conflicts.filter((c) => c.status === "OPEN").map((cf) => (
            <div key={cf.conflictId} className="rounded border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium"><Scale size={14} aria-hidden /> {cf.fieldName}</span>
                <span className="font-mono text-xs text-muted-foreground">{cf.conflictId} · {cf.providerType} · case {cf.caseRef ?? "—"}</span>
              </div>
              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded border p-2">
                  <div className="text-xs font-semibold text-muted-foreground">CENTRAL ({cf.centralSource})</div>
                  <div>{cf.centralValue ?? "—"}</div>
                </div>
                <div className="rounded border border-amber-300 bg-amber-50 p-2">
                  <div className="text-xs font-semibold text-amber-700">EXTERNAL ({cf.externalSource})</div>
                  <div>{cf.externalValue ?? "—"}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {["RESOLVED_CENTRAL", "RESOLVED_EXTERNAL", "IGNORED"].map((res) => (
                  <Button key={res} size="sm" variant="outline" disabled={busy !== null}
                    onClick={async () => {
                      setBusy(cf.conflictId);
                      try {
                        const r = await api.post<{ applied: boolean }>(`/api/v1/integrations/conflicts/${cf.conflictId}/resolve`, { resolution: res, note: `Resolved via review UI (${res})` });
                        setNotice(`Conflict ${cf.conflictId} → ${res}${r.applied ? " (external value applied)" : " (central record kept)"}.`);
                        await load();
                      } catch (err) {
                        setNotice(err instanceof ApiClientError ? err.message : "Resolution failed.");
                      } finally { setBusy(null); }
                    }}>
                    {res.replace("RESOLVED_", "")}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Import jobs</CardTitle></CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          {jobs.imports.length === 0 && <p className="text-muted-foreground">No import jobs yet.</p>}
          {jobs.imports.map((j) => (
            <button key={j.jobId} className="flex w-full flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-left hover:bg-accent"
              onClick={async () => {
                setSelected(await api.get<ImportJobDetail>(`/api/v1/integrations/jobs/${j.jobId}`));
                setManifest(null);
              }}>
              <span className="font-mono text-xs">{j.jobId}</span>
              <span>{j.connection.displayName}</span>
              <span>{j.importType}</span>
              <span>{j.recordsImported}/{j.recordsReceived} ok{ j.recordsConflicted > 0 ? ` · ${j.recordsConflicted} conflicts` : ""}{j.recordsSkipped > 0 ? ` · ${j.recordsSkipped} duplicates` : ""}</span>
              <Badge className={jobStatusBadge(j.status)} variant="secondary">{j.status}</Badge>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Export jobs</CardTitle></CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          {jobs.exports.length === 0 && <p className="text-muted-foreground">No export jobs yet.</p>}
          {jobs.exports.map((j) => (
            <div key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
              <button className="font-mono text-xs underline-offset-2 hover:underline"
                onClick={async () => {
                  try {
                    setManifest(await api.get(`/api/v1/integrations/jobs/${j.jobId}/manifest`));
                  } catch { setManifest(null); }
                }}>
                {j.jobId} (manifest)
              </button>
              <span>{j.connection.displayName}</span>
              <span>{j.recordsExported}/{j.recordsSelected} ok</span>
              <Badge className={jobStatusBadge(j.status)} variant="secondary">{j.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {selected && selected.kind === "IMPORT" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Job {selected.jobId} — staged records</CardTitle>
            <CardDescription>
              {selected.connection.displayName} · {selected.importType} · schema v{selected.schemaVersion ?? "?"} · mapping v{selected.mappingVersion ?? "?"} · by {selected.requestedBy.name}
              {selected.errorSummary ? ` — ${selected.errorSummary}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {selected.records?.map((r) => (
              <div key={r.id} className="rounded border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs">{r.externalRecordId} ({r.recordType})</span>
                  <span className="flex items-center gap-2">
                    {r.validationStatus === "VALID" ? <CheckCircle2 size={13} className="text-emerald-600" aria-hidden /> : <XCircle size={13} className="text-red-500" aria-hidden />}
                    <span>{r.validationStatus}</span>
                    <Badge variant="secondary">{r.processingStatus}</Badge>
                  </span>
                </div>
                {r.centralRecordRef && <div className="mt-1 text-xs text-muted-foreground">Central record: <span className="font-mono">{r.centralRecordRef}</span></div>}
                {r.errorDetails && <div className="mt-1 rounded bg-red-50 p-1.5 text-xs text-red-800">{r.errorDetails}</div>}
                {r.validationErrors?.errors && r.validationErrors.errors.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {r.validationErrors.errors.slice(0, 5).map((e, i) => (
                      <div key={i} className="text-xs text-red-700">{e.code} @ {e.field}: {e.message}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>
          </CardContent>
        </Card>
      )}

      {manifest && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-base"><Download size={15} aria-hidden /> Integrity manifest — {manifest.jobId}</CardTitle>
            <CardDescription>Case {manifest.case.caseId} · {manifest.manifest.entries.length} file entr{manifest.manifest.entries.length === 1 ? "y" : "ies"} · algorithm {manifest.manifest.algorithm}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            {manifest.manifest.entries.map((e) => (
              <div key={e.documentId} className="rounded border p-2 font-mono">
                {e.documentId} · {e.filename} · {e.mimeType} · {e.size} B
                <div className="text-muted-foreground">sha256 {e.sha256}</div>
                <div className="text-muted-foreground">exported {new Date(e.exportedAt).toISOString()} · job {e.exportJobId}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
