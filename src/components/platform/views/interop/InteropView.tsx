"use client";

import * as React from "react";
import { api, type InteropExportJob, type InteropImportJobRow, type InteropConflict } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge, LoadingState, ErrorState } from "@/components/platform/common";
import { ArrowRightLeft, FileDown, FileUp, Gavel, PackageSearch, ShieldAlert, Timer } from "lucide-react";
import { useAuth } from "@/lib/client/store";

// ============================================================
// /interoperability — dashboard (spec §55): Exports, Imports,
// Pending Reviews, Conflicts, Expired Packages, Failed Jobs,
// Package Search. Manual packages are the FALLBACK interop
// channel — the framing is repeated on every card.
// ============================================================

export function InteroperabilityView({ onOpenExport, onOpenImport }: { onOpenExport: () => void; onOpenImport: () => void }) {
  const { me } = useAuth();
  const [exports, setExports] = React.useState<InteropExportJob[] | null>(null);
  const [imports, setImports] = React.useState<InteropImportJobRow[] | null>(null);
  const [conflicts, setConflicts] = React.useState<InteropConflict[] | null>(null);
  const [searchId, setSearchId] = React.useState("");
  const [searchResult, setSearchResult] = React.useState<Record<string, unknown> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [e, i, c] = await Promise.all([
        api.get<InteropExportJob[]>("/api/v1/interoperability/exports"),
        api.get<InteropImportJobRow[]>("/api/v1/interoperability/imports"),
        api.get<InteropConflict[]>("/api/v1/interoperability/conflicts"),
      ]);
      setExports(e);
      setImports(i);
      setConflicts(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load interoperability data.");
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function searchPackage() {
    if (!searchId.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setSearchResult(await api.get(`/api/v1/interoperability/packages/${encodeURIComponent(searchId.trim())}`));
    } catch (err) {
      setSearchResult(null);
      setError(err instanceof Error ? err.message : "Package not found.");
    } finally {
      setSearching(false);
    }
  }

  const pendingReviews = (imports ?? []).filter((j) => ["STAGED", "REVIEW_REQUIRED"].includes(j.status)).length;
  const expired = (exports ?? []).filter((j) => j.status === "EXPIRED").length;
  const failedJobs = (exports ?? []).filter((j) => j.status === "FAILED").length + (imports ?? []).filter((j) => j.status === "FAILED").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Interoperability</h1>
        <p className="text-sm text-muted-foreground">
          Manual import/export is the controlled FALLBACK for exchanging data with systems that have no API integration. A package is a file transfer — it is never described as a live system connection.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Button className="h-24 flex-col gap-2" variant="outline" onClick={onOpenExport}>
          <FileDown aria-hidden size={20} /> Export a case package
        </Button>
        <Button className="h-24 flex-col gap-2" variant="outline" onClick={onOpenImport}>
          <FileUp aria-hidden size={20} /> Import a package
        </Button>
        <Card className="col-span-1">
          <CardContent className="flex h-24 items-center gap-3 p-4">
            <Gavel aria-hidden size={20} className="text-muted-foreground" />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending reviews</p>
              <p className="text-xl font-semibold">{pendingReviews}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="col-span-1">
          <CardContent className="flex h-24 items-center gap-3 p-4">
            <ShieldAlert aria-hidden size={20} className="text-muted-foreground" />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Open conflicts</p>
              <p className="text-xl font-semibold">{(conflicts ?? []).filter((c) => c.status === "OPEN").length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Package search</CardTitle>
          <CardDescription>Look up any package by ID (PKG-MP-IND-…).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input className="max-w-xs" placeholder="PKG-MP-IND-2026-000001" value={searchId} onChange={(e) => setSearchId(e.target.value)} />
          <Button onClick={searchPackage} disabled={!searchId.trim() || searching}>
            <PackageSearch aria-hidden size={14} className="mr-1.5" /> Inspect
          </Button>
        </CardContent>
      </Card>

      {searchResult && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Package inspector</CardTitle></CardHeader>
          <CardContent className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <p><span className="text-muted-foreground">ID:</span> <span className="font-mono text-xs">{String(searchResult.packageId)}</span></p>
            <p><span className="text-muted-foreground">Type:</span> {String(searchResult.packageType)}</p>
            <p><span className="text-muted-foreground">Source:</span> {String(searchResult.sourceSystem)}</p>
            <p><span className="text-muted-foreground">Classification:</span> {String(searchResult.classification)}</p>
            <p><span className="text-muted-foreground">Records:</span> {String(searchResult.caseCount)}C / {String(searchResult.documentCount)}D / {String(searchResult.evidenceCount)}E / {String(searchResult.relationshipCount)}R</p>
            <p><span className="text-muted-foreground">Downloads:</span> {String(searchResult.downloads)}</p>
            <p className="sm:col-span-2 break-all font-mono text-[11px] text-muted-foreground">SHA-256: {String(searchResult.packageSha256)}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><ArrowRightLeft aria-hidden size={15} /> Exports</CardTitle>
            <CardDescription>Recently created export jobs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {exports === null ? (
              <LoadingState rows={3} />
            ) : exports.length === 0 ? (
              <p className="text-muted-foreground">No export jobs yet.</p>
            ) : (
              exports.slice(0, 8).map((j) => (
                <div key={j.jobId} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-xs">{j.packageId ?? j.jobId}</span>
                  <Badge variant="outline" className="text-[10px]">{j.exportType}</Badge>
                  {j.expiresAt && j.status === "COMPLETED" && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><Timer aria-hidden size={12} /> {new Date(j.expiresAt).toLocaleString()}</span>
                  )}
                </div>
              ))
            )}
            <p className="pt-1 text-xs text-muted-foreground">Expired packages: {expired} · Failed jobs: {failedJobs}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><FileUp aria-hidden size={15} /> Imports</CardTitle>
            <CardDescription>Recently uploaded packages and their pipeline stage.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {imports === null ? (
              <LoadingState rows={3} />
            ) : imports.length === 0 ? (
              <p className="text-muted-foreground">No import jobs yet.</p>
            ) : (
              imports.slice(0, 8).map((j) => (
                <div key={j.jobId} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-xs">{j.packageId ?? j.jobId}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{j.recordsReceived > 0 ? `${j.recordsImported}/${j.recordsReceived}` : "staged"} · {j.stage ?? "—"}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
