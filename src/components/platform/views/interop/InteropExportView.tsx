"use client";

import * as React from "react";
import { api, type InteropExportPreview, type InteropExportJob } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/platform/common";
import { ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { Download, FileArchive, Info } from "lucide-react";
import { useAuth } from "@/lib/client/store";

// ============================================================
// /interoperability/export — MANUAL export workflow (spec §56).
// Shows the EXACT authorized scope before packaging; packages are
// manual transfers, never live integrations.
// ============================================================

function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function InteropExportView({ onOpenCase }: { onOpenCase?: (caseId: string) => void }) {
  const { me } = useAuth();
  const [caseRef, setCaseRef] = React.useState("");
  const [preview, setPreview] = React.useState<InteropExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [packageType, setPackageType] = React.useState("FULL_CASE_EXPORT");
  const [purpose, setPurpose] = React.useState("");
  const [includeAudit, setIncludeAudit] = React.useState(false);
  const [selectedDocs, setSelectedDocs] = React.useState<Set<string>>(new Set());
  const [selectedEvidence, setSelectedEvidence] = React.useState<Set<string>>(new Set());
  const [includeRelationships, setIncludeRelationships] = React.useState(true);
  const [job, setJob] = React.useState<InteropExportJob | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [downloadUrl, setDownloadUrl] = React.useState<string | null>(null);

  async function loadPreview() {
    setPreview(null);
    setJob(null);
    setError(null);
    if (!caseRef.trim()) return;
    setPreviewLoading(true);
    try {
      const p = await api.get<InteropExportPreview>(`/api/v1/interoperability/exports/preview?caseRef=${encodeURIComponent(caseRef.trim())}`);
      setPreview(p);
      setSelectedDocs(new Set(p.documents.filter((d) => d.selectable).map((d) => d.documentId)));
      setSelectedEvidence(new Set(p.evidence.filter((e) => e.selectable).map((e) => e.evidenceId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load export preview.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runExport() {
    setBusy(true);
    setError(null);
    setJob(null);
    setDownloadUrl(null);
    try {
      const res = await api.post<{ job: InteropExportJob; packageId: string }>("/api/v1/interoperability/exports", {
        caseRef: caseRef.trim(),
        packageType,
        purpose: purpose || null,
        documentIds: packageType === "FULL_CASE_EXPORT" ? null : [...selectedDocs],
        evidenceIds: packageType === "FULL_CASE_EXPORT" ? null : [...selectedEvidence],
        includeRelationships,
        includeAuditEvents: includeAudit,
      });
      setJob(res.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPackage() {
    if (!job) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/interoperability/exports/${job.jobId}/download`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job.packageId ?? job.jobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setDownloadUrl(`${job.packageId ?? job.jobId}.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  const viewableDocs = preview?.documents.filter((d) => d.selectable).length ?? 0;
  const viewableEvidence = preview?.evidence.filter((e) => e.selectable).length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Manual Export</h1>
        <p className="text-sm text-muted-foreground">
          Build a secure interoperability package for systems without an API connection. A manual package is a controlled file transfer — it is never a live system integration.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Select case</CardTitle>
          <CardDescription>Only cases you are authorized to view can be exported. Unauthorized records are excluded server-side.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="export-case">Case ID</Label>
            <Input
              id="export-case"
              placeholder="CASE-MP-IND-2026-000001"
              value={caseRef}
              onChange={(e) => setCaseRef(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadPreview()}
            />
          </div>
          <Button onClick={loadPreview} disabled={!caseRef.trim() || previewLoading}>
            Load authorized scope
          </Button>
        </CardContent>
      </Card>

      {previewLoading && <LoadingState label="Validating authorization" rows={4} />}
      <FieldError message={error || undefined} />


      {preview && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">2. Review included records — exact export scope</CardTitle>
              <CardDescription>
                {preview.caseId} · {preview.title} — {viewableDocs} viewable document(s), {viewableEvidence} viewable evidence record(s).
                {onOpenCase && (
                  <button className="ml-2 text-xs underline underline-offset-4" onClick={() => onOpenCase(preview.caseId)}>
                    Open case
                  </button>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pkg-type">3. Package type</Label>
                <Select value={packageType} onValueChange={setPackageType}>
                  <SelectTrigger id="pkg-type" className="w-72"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FULL_CASE_EXPORT">FULL_CASE_EXPORT — everything authorized</SelectItem>
                    <SelectItem value="CASE_EXPORT">CASE_EXPORT — my selection</SelectItem>
                    <SelectItem value="DOCUMENT_EXPORT">DOCUMENT_EXPORT — documents only</SelectItem>
                    <SelectItem value="EVIDENCE_EXPORT">EVIDENCE_EXPORT — evidence only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pkg-purpose">Export purpose (recorded in package metadata)</Label>
                <Input id="pkg-purpose" placeholder="e.g. Court submission to District Court" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={500} />
              </div>

              {packageType !== "FULL_CASE_EXPORT" && packageType !== "EVIDENCE_EXPORT" && (
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-sm font-medium">Documents ({viewableDocs} authorized / {preview.documents.length} total)</p>
                  <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {preview.documents.map((d) => (
                      <label key={d.documentId} className={`flex items-center gap-2 rounded px-1 py-0.5 text-sm ${d.selectable ? "" : "opacity-50"}`}>
                        <Checkbox
                          checked={selectedDocs.has(d.documentId)}
                          disabled={!d.selectable || packageType === "FULL_CASE_EXPORT"}
                          onCheckedChange={(v) => {
                            setSelectedDocs((prev) => {
                              const next = new Set(prev);
                              if (v) next.add(d.documentId);
                              else next.delete(d.documentId);
                              return next;
                            });
                          }}
                        />
                        <span className="truncate">{d.title}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{d.classification}</Badge>
                        {!d.selectable && <span className="shrink-0 text-xs text-muted-foreground">EXCLUDED_CLEARANCE</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {packageType !== "FULL_CASE_EXPORT" && packageType !== "DOCUMENT_EXPORT" && (
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-sm font-medium">Evidence ({viewableEvidence} authorized / {preview.evidence.length} total)</p>
                  <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {preview.evidence.map((e) => (
                      <label key={e.evidenceId} className={`flex items-center gap-2 rounded px-1 py-0.5 text-sm ${e.selectable ? "" : "opacity-50"}`}>
                        <Checkbox
                          checked={selectedEvidence.has(e.evidenceId)}
                          disabled={!e.selectable || packageType === "FULL_CASE_EXPORT"}
                          onCheckedChange={(v) => {
                            setSelectedEvidence((prev) => {
                              const next = new Set(prev);
                              if (v) next.add(e.evidenceId);
                              else next.delete(e.evidenceId);
                              return next;
                            });
                          }}
                        />
                        <span className="truncate">{e.title}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{e.classification}</Badge>
                        {!e.selectable && <span className="shrink-0 text-xs text-muted-foreground">EXCLUDED_CLEARANCE</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={includeRelationships} onCheckedChange={(v) => setIncludeRelationships(v === true)} />
                  Include document relationships
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={includeAudit} onCheckedChange={(v) => setIncludeAudit(v === true)} />
                  Include derived audit events (opt-in — the central ledger stays authoritative)
                </label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">4. Generate package</CardTitle>
              <CardDescription>SHA-256 integrity manifest, deterministic packaging, encrypted temporary storage, {job?.expiresAt ? "24 h" : "TTL-bound"} expiration.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={runExport} disabled={busy}>
                <FileArchive aria-hidden size={15} className="mr-2" /> {busy ? "Building package…" : "Generate package"}
              </Button>

              {job && (
                <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={job.status} />
                    <span className="font-mono text-xs">{job.jobId}</span>
                    {job.packageId && <span className="font-mono text-xs">{job.packageId}</span>}
                  </div>
                  {job.recordCounts && (
                    <p className="text-muted-foreground">
                      Documents: {job.recordCounts.documents} · Evidence: {job.recordCounts.evidence} · Relationships: {job.recordCounts.relationships} · Audit events: {job.recordCounts.auditEvents} · Excluded: {job.recordCounts.excluded}
                    </p>
                  )}
                  {job.classification && <p>Package classification: <Badge variant="outline">{job.classification}</Badge></p>}
                  {job.packageSha256 && <p className="break-all font-mono text-xs text-muted-foreground">SHA-256: {job.packageSha256}</p>}
                  {job.expiresAt && <p className="text-muted-foreground">Expires: {new Date(job.expiresAt).toLocaleString()}</p>}
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
                    Transfer the package only through approved secure channels. The SHA-256 hash proves the package is unmodified — it does not prove who created it.
                  </p>
                  {job.status === "COMPLETED" && (
                    <div className="flex items-center gap-3 pt-1">
                      <Button size="sm" onClick={downloadPackage} disabled={busy}>
                        <Download aria-hidden size={14} className="mr-1.5" /> Download package
                      </Button>
                      {downloadUrl && <span className="text-xs text-muted-foreground">Saved as {downloadUrl}</span>}
                    </div>
                  )}
                  {me?.officer.role === "AUDITOR" && <p className="text-xs text-muted-foreground">Auditors have read-only interop oversight.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
