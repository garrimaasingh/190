"use client";

import * as React from "react";
import { api, ApiClientError, type EvidenceListResponse, type EvidenceRow, type Meta } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingState } from "@/components/platform/common";
import { ClassificationBadge } from "@/components/platform/DocumentsSection";
import { Boxes, Download as DownloadIcon, Info, Plus } from "lucide-react";

// ============================================================
// Evidence section of the case dashboard (spec §37).
// The table renders ONLY rows the server returned — case access +
// classification clearance filtering happen in the query (spec §19).
// "Download" appears only for digital items; physical evidence says
// so explicitly instead of hiding the action.
// ============================================================

const EVIDENCE_STATUS_STYLES: Record<string, string> = {
  REGISTERED: "bg-zinc-100 text-zinc-800 border-zinc-300",
  COLLECTED: "bg-sky-100 text-sky-900 border-sky-300",
  IN_CUSTODY: "bg-emerald-100 text-emerald-900 border-emerald-300",
  TRANSFER_PENDING: "bg-amber-100 text-amber-900 border-amber-300",
  TRANSFERRED: "bg-violet-100 text-violet-900 border-violet-300",
  UNDER_EXAMINATION: "bg-cyan-100 text-cyan-900 border-cyan-300",
  RETURNED: "bg-slate-100 text-slate-800 border-slate-300",
  RELEASED: "bg-stone-100 text-stone-800 border-stone-300",
  ARCHIVED: "bg-gray-100 text-gray-600 border-gray-300",
};

export function EvidenceStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={`${EVIDENCE_STATUS_STYLES[status] || ""} font-medium`}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface EvidenceSectionProps {
  caseRef: string;
  meta: Meta | null;
  onRegister: () => void;
  onOpenEvidence: (evidenceId: string) => void;
}

export function EvidenceSection({ caseRef, meta, onRegister, onOpenEvidence }: EvidenceSectionProps) {
  const [data, setData] = React.useState<EvidenceListResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await api.get<EvidenceListResponse>(`/api/v1/cases/${caseRef}/evidence?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load evidence.");
    }
  }, [caseRef, q, typeFilter, statusFilter]);

  React.useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load]);

  const evidenceTypes = meta?.evidenceTypes ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Boxes size={16} aria-hidden /> Evidence
            </CardTitle>
            <CardDescription>
              Items under custody in this case. Digital items carry a SHA-256 integrity fingerprint; physical items are tracked by custody records only.
            </CardDescription>
          </div>
          {data?.canRegister && (
            <Button size="sm" onClick={onRegister}>
              <Plus size={16} aria-hidden /> Register Evidence
            </Button>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Search title, description, evidence ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="sm:max-w-xs"
            aria-label="Search evidence"
          />
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="sm:w-44" aria-label="Filter by evidence type">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {evidenceTypes.map((t) => (
                <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="sm:w-48" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(meta?.evidenceStatuses ?? []).map((s) => (
                <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState message={error} />
        ) : !data ? (
          <LoadingState rows={2} />
        ) : data.items.length === 0 ? (
          <EmptyState
            icon={<Boxes className="h-8 w-8 text-muted-foreground" aria-hidden />}
            title="No evidence visible"
            message="No evidence items match your filters — or your clearance does not cover the items on this case."
          />
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evidence ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead>Classification</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Current Custodian</TableHead>
                  <TableHead className="hidden lg:table-cell">Collected</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((e: EvidenceRow) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.id}</TableCell>
                    <TableCell className="max-w-52">
                      <button
                        type="button"
                        className="text-left font-medium underline-offset-2 hover:underline"
                        onClick={() => onOpenEvidence(e.id)}
                      >
                        {e.title}
                      </button>
                      {e.hasDigitalContent && (
                        <span className="block text-xs text-muted-foreground">
                          {e.originalFilename} · {e.mimeType?.split("/").pop()?.toUpperCase()}
                        </span>
                      )}
                      {!e.hasDigitalContent && (
                        <span className="block text-xs text-muted-foreground">Physical item — no digital content</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm">{e.evidenceType.replaceAll("_", " ")}</TableCell>
                    <TableCell><ClassificationBadge classification={e.classification} /></TableCell>
                    <TableCell><EvidenceStatusBadge status={e.status} /></TableCell>
                    <TableCell className="hidden lg:table-cell text-sm">{e.currentCustodianDepartment?.name ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{fmtDateTime(e.collectedAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onOpenEvidence(e.id)} aria-label={`View details of ${e.title}`}>
                          <Info size={16} aria-hidden />
                        </Button>
                        {e.hasDigitalContent && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Download ${e.title}`}
                            onClick={async () => {
                              try {
                                const res = await fetch(`/api/v1/cases/${caseRef}/evidence/${e.id}/download`, { credentials: "same-origin" });
                                if (!res.ok) throw new Error("Download failed.");
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = e.originalFilename || e.id;
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                                setTimeout(() => URL.revokeObjectURL(url), 5000);
                              } catch {
                                setError("Download failed — you may not be authorized.");
                              }
                            }}
                          >
                            <DownloadIcon size={16} aria-hidden />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
