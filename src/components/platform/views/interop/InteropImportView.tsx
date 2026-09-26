"use client";

import * as React from "react";
import { api, type InteropImportJobRow, type InteropImportJobDetail, type InteropCommitResult, type InteropConflict } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/platform/common";
import { ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { Upload, ShieldCheck, CheckCircle2, XCircle, Info } from "lucide-react";
import { useAuth } from "@/lib/client/store";

// ============================================================
// /interoperability/import — MANUAL import workflow (spec §57).
// Upload → validate (archive security, schema, integrity, scan) →
// package inspector → staging → conflict resolution → review →
// approval → commit → honest final report. Manual transfer only —
// never a live integration.
// ============================================================

const STAGES = ["UPLOADED", "ARCHIVE_SECURITY", "PACKAGE_IDENTITY", "SECURITY_SCAN", "REFERENCE_RESOLUTION", "STAGED", "APPROVED", "IMPORTING", "COMPLETED"];
function stageProgress(stage: string | null): number {
  if (!stage) return 0;
  const idx = STAGES.indexOf(stage);
  if (idx < 0) return 100;
  return Math.round(((idx + 1) / STAGES.length) * 100);
}

function ConflictCard({ conflict, onResolve, busy }: { conflict: InteropConflict; onResolve: (id: string, resolution: string) => void; busy: boolean }) {
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant={conflict.status === "OPEN" ? "destructive" : "outline"}>{conflict.status === "OPEN" ? "OPEN" : conflict.status}</Badge>
        <span className="font-medium">{conflict.recordType}</span>
        <span className="font-mono text-xs text-muted-foreground">{conflict.recordRecordId}</span>
        <span className="text-xs text-muted-foreground">field: {conflict.fieldName} · type: {conflict.conflictType}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded border bg-muted/30 p-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Existing central value</p>
          <p className="break-words">{conflict.centralValue ?? "—"}</p>
        </div>
        <div className="rounded border bg-amber-500/5 p-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Incoming value ({conflict.sourceReference ?? "package"})</p>
          <p className="break-words">{conflict.incomingValue ?? "—"}</p>
        </div>
      </div>
      {conflict.status === "OPEN" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {conflict.conflictType === "IMMUTABLE_FIELD" ? (
            <p className="text-xs text-muted-foreground">Immutable central field — only Keep Central or Reject Record are permitted.</p>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy || conflict.conflictType === "IMMUTABLE_FIELD"} onClick={() => onResolve(conflict.conflictId, "ACCEPT_INCOMING")}>Accept Incoming</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(conflict.conflictId, "KEEP_CENTRAL")}>Keep Central</Button>
          <Button size="sm" variant="outline" disabled={busy || conflict.conflictType === "IMMUTABLE_FIELD"} onClick={() => onResolve(conflict.conflictId, "MERGE")}>Merge</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => onResolve(conflict.conflictId, "REJECT_RECORD")}>Reject Record</Button>
        </div>
      ) : (
        conflict.resolutionNote && <p className="mt-1 text-xs text-muted-foreground">Note: {conflict.resolutionNote}</p>
      )}
    </div>
  );
}

export function InteropImportView() {
  const { me } = useAuth();
  const [jobs, setJobs] = React.useState<InteropImportJobRow[] | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [purpose, setPurpose] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<InteropImportJobDetail | null>(null);
  const [commitResult, setCommitResult] = React.useState<InteropCommitResult | null>(null);

  const canReview = me?.officer.role === "SYSTEM_ADMIN" || me?.officer.role === "DEPARTMENT_ADMIN";

  const loadJobs = React.useCallback(async () => {
    try {
      setJobs(await api.get<InteropImportJobRow[]>("/api/v1/interoperability/imports"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load import jobs.");
    }
  }, []);

  React.useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  async function openJob(jobId: string) {
    setError(null);
    setCommitResult(null);
    try {
      setDetail(await api.get<InteropImportJobDetail>(`/api/v1/interoperability/imports/${jobId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load job.");
    }
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("package", file);
      if (purpose) form.append("purpose", purpose);
      const job = await api.upload<InteropImportJobRow>("/api/v1/interoperability/imports", form);
      setFile(null);
      await loadJobs();
      await openJob(job.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function action(jobId: string, act: "validate" | "approve" | "reject" | "commit", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/interoperability/imports/${jobId}/${act}`, body ?? {});
      const fresh = await api.get<InteropImportJobDetail>(`/api/v1/interoperability/imports/${jobId}`);
      setDetail(fresh);
      if (act === "commit" && fresh.job.status !== "IMPORTING") {
        // commit result includes counters — refetch detail carries them via job
      }
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${act} failed.`);
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(conflictId: string, resolution: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/interoperability/conflicts/${conflictId}/resolve`, { resolution, note: null });
      if (detail) await openJob(detail.job.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Manual Import</h1>
        <p className="text-sm text-muted-foreground">
          Import a manually transferred interoperability package. Every package passes archive-security, schema, integrity and security-scan gates before anything is staged — nothing touches central records until review and approval.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Upload package</CardTitle>
          <CardDescription>ZIP packages only (schema version 1.0). Duplicates (same SHA-256) are detected and refused.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="import-file">Package file</Label>
            <input
              id="import-file"
              type="file"
              accept=".zip"
              className="block w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-purpose">Purpose (optional, recorded on the job)</Label>
            <input
              id="import-purpose"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              placeholder="e.g. Incoming case file from District Court"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              maxLength={500}
            />
          </div>
          <Button onClick={upload} disabled={!file || busy}>
            <Upload aria-hidden size={15} className="mr-2" /> {busy ? "Uploading…" : "Upload package"}
          </Button>
        </CardContent>
      </Card>

      <FieldError message={error || undefined} />
      {busy && !detail && <LoadingState rows={3} />}

      {detail && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">2. Package Inspector</CardTitle>
                <StatusBadge status={detail.job.status} />
              </div>
              <CardDescription>Identity and integrity facts — payload contents stay hidden until records are committed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                <p><span className="text-muted-foreground">Job:</span> <span className="font-mono text-xs">{detail.job.jobId}</span></p>
                <p><span className="text-muted-foreground">Package ID:</span> <span className="font-mono text-xs">{detail.job.packageId ?? "—"}</span></p>
                <p><span className="text-muted-foreground">Source:</span> {detail.job.sourceSystem ?? "—"}</p>
                <p><span className="text-muted-foreground">Schema version:</span> {detail.job.schemaVersion ?? "—"}</p>
                <p><span className="text-muted-foreground">Classification:</span> {detail.job.packageTypeClassification ? <Badge variant="outline" className="ml-1">{detail.job.packageTypeClassification}</Badge> : "—"}</p>
                <p><span className="text-muted-foreground">Integrity:</span> {detail.job.integrityResult ?? "PENDING"}</p>
                <p><span className="text-muted-foreground">Signature:</span> {detail.job.signatureStatus ?? "UNSUPPORTED"}</p>
                <p><span className="text-muted-foreground">Security scan:</span> {detail.job.scanStatus ?? "PENDING"}</p>
                <p><span className="text-muted-foreground">Records:</span> received {detail.job.recordsReceived} · valid {detail.job.recordsValid} · invalid {detail.job.recordsInvalid} · conflicts {detail.job.recordsConflicted}</p>
                <p><span className="text-muted-foreground">Uploaded by:</span> {detail.job.uploadedByOfficer?.name ?? "—"}</p>
              </div>
              {detail.package && (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  Package SHA-256: {detail.package.packageSha256} · manifest hash: {detail.package.manifestHash.slice(0, 24)}…
                </p>
              )}
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
                A matching hash proves the package is unmodified — it does not prove who created it. Signature status is UNSUPPORTED unless a signing service is configured.
              </p>

              <div className="flex flex-wrap gap-2 pt-1">
                {["UPLOADED", "FAILED", "VALIDATING"].includes(detail.job.status) && canReview && (
                  <Button size="sm" onClick={() => action(detail.job.jobId, "validate")} disabled={busy}>
                    <ShieldCheck aria-hidden size={14} className="mr-1.5" /> Validate & stage
                  </Button>
                )}
                {["STAGED", "REVIEW_REQUIRED"].includes(detail.job.status) && canReview && detail.job.uploadedByDepartmentId === me?.department?.id && (
                  <>
                    <Button size="sm" onClick={() => action(detail.job.jobId, "approve", { comment: null })} disabled={busy || detail.conflicts.some((c) => c.status === "OPEN")}>
                      <CheckCircle2 aria-hidden size={14} className="mr-1.5" /> Approve import
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => action(detail.job.jobId, "reject", { comment: "Rejected via review UI" })} disabled={busy}>
                      <XCircle aria-hidden size={14} className="mr-1.5" /> Reject
                    </Button>
                  </>
                )}
                {/* §39/§45: approval-gated jobs wait for a reviewer; jobs that need no
                    approval can be committed straight from STAGED. */}
                {(detail.job.status === "APPROVED" || (detail.job.status === "STAGED" && !detail.job.requiresApproval)) && canReview && (
                  <Button size="sm" onClick={() => action(detail.job.jobId, "commit")} disabled={busy}>
                    Commit import (Phase 3/4 pipelines)
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {detail.conflicts.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">3. Conflicts ({detail.conflicts.filter((c) => c.status === "OPEN").length} open / {detail.conflicts.length})</CardTitle>
                <CardDescription>Immutable central fields can never be overwritten; classifications can never be downgraded.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.conflicts.map((c) => (
                  <ConflictCard key={c.conflictId} conflict={c} onResolve={resolveConflict} busy={busy} />
                ))}
              </CardContent>
            </Card>
          )}

          {detail.records.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">4. Staged records</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {detail.records.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
                    <Badge variant="outline" className="text-[10px]">{r.recordType}</Badge>
                    <span className="font-mono text-xs">{r.externalId}</span>
                    <span className="text-xs text-muted-foreground">{r.resolution}</span>
                    {r.targetEntityId && <span className="text-xs">→ {r.targetEntityId}</span>}
                    <Badge variant={r.processingStatus === "IMPORTED" ? "default" : r.processingStatus === "REJECTED" ? "destructive" : "secondary"} className="ml-auto text-[10px]">
                      {r.processingStatus}
                    </Badge>
                    {r.errorDetails && <span className="w-full text-xs text-muted-foreground">{r.errorDetails}</span>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {["COMPLETED", "PARTIAL", "FAILED", "REJECTED"].includes(detail.job.status) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">5. Final import report</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-4">
                  <p><span className="text-muted-foreground">Imported:</span> <span className="font-semibold">{detail.job.recordsImported}</span></p>
                  <p><span className="text-muted-foreground">Rejected:</span> <span className="font-semibold">{detail.job.recordsInvalid}</span></p>
                  <p><span className="text-muted-foreground">Conflicted:</span> <span className="font-semibold">{detail.job.recordsConflicted}</span></p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Final status: {detail.job.status}. {detail.job.status === "PARTIAL" && "Some records failed or were rejected — PARTIAL is reported honestly, never as SUCCESS."}
                </p>
                {detail.job.errorMessage && <p className="text-xs text-destructive">{detail.job.errorCode}: {detail.job.errorMessage}</p>}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Import jobs</CardTitle>
          <CardDescription>Stage reflects the actual pipeline position — progress is never faked.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobs === null ? (
            <LoadingState rows={3} />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No import jobs yet.</p>
          ) : (
            jobs.map((j) => (
              <button key={j.jobId} onClick={() => openJob(j.jobId)} className="flex w-full flex-wrap items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50">
                <StatusBadge status={j.status} />
                <span className="font-mono text-xs">{j.jobId}</span>
                <span className="text-xs text-muted-foreground">{j.sourceSystem ?? "—"} · schema {j.schemaVersion ?? "—"}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {j.recordsReceived > 0 ? `${j.recordsImported}/${j.recordsReceived} imported` : "not validated"} · stage {stageProgress(j.stage)}%
                </span>
                {j.requiresApproval && j.status !== "COMPLETED" && <Badge variant="outline" className="text-[10px]">approval required</Badge>}
              </button>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
