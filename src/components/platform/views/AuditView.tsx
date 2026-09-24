"use client";

import * as React from "react";
import { api, ApiClientError, type AuditListResponse, type AuditEventRow, type Meta } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingState } from "@/components/platform/common";
import { ArrowLeft, Search, ShieldEllipsis } from "lucide-react";

// ============================================================
// Audit Log dashboard (spec §60/§33/§34). AUDITOR + SYSTEM_ADMIN.
// Server-side pagination; every search is itself audited. Filters:
// free text, event type/category, officer, department, case,
// document, evidence, result, date range.
// ============================================================

const RESULT_STYLES: Record<string, string> = {
  SUCCESS: "bg-emerald-100 text-emerald-900 border-emerald-300",
  DENIED: "bg-red-100 text-red-900 border-red-300",
  FAILED: "bg-amber-100 text-amber-900 border-amber-300",
};

function shortHash(h: string): string {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—";
}

function fmt(v: string | null): string {
  if (!v) return "—";
  return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function AuditView({
  meta,
  onOpenEvent,
  onOpenIntegrity,
}: {
  meta: Meta | null;
  onOpenEvent: (eventId: string) => void;
  onOpenIntegrity: () => void;
}) {
  const [data, setData] = React.useState<AuditListResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);

  // filters
  const [q, setQ] = React.useState("");
  const [eventType, setEventType] = React.useState("all");
  const [category, setCategory] = React.useState("all");
  const [result, setResult] = React.useState("all");
  const [caseId, setCaseId] = React.useState("");
  const [evidenceId, setEvidenceId] = React.useState("");
  const [actorOfficerId, setActorOfficerId] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", "20");
      if (q.trim()) params.set("q", q.trim());
      if (eventType !== "all") params.set("eventType", eventType);
      if (category !== "all") params.set("category", category);
      if (result !== "all") params.set("result", result);
      if (caseId.trim()) params.set("caseId", caseId.trim());
      if (evidenceId.trim()) params.set("evidenceId", evidenceId.trim());
      if (actorOfficerId.trim()) params.set("actorOfficerId", actorOfficerId.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const res = await api.get<AuditListResponse>(`/api/v1/audit?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load the audit log.");
    }
  }, [page, q, eventType, category, result, caseId, evidenceId, actorOfficerId, dateFrom, dateTo]);

  React.useEffect(() => {
    const t = setTimeout(load, q || caseId || evidenceId ? 300 : 0);
    return () => clearTimeout(t);
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Immutable, hash-chained record of sensitive operations. Entries can never be edited or deleted — corrections are new events.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpenIntegrity}>
          <ShieldEllipsis size={16} aria-hidden /> Verify Chain
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" aria-hidden />
            <Input className="pl-8" placeholder="Event ID, case, document, evidence…" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} aria-label="Search audit events" />
          </div>
          <Select value={category} onValueChange={(v) => { setPage(1); setCategory(v); }}>
            <SelectTrigger aria-label="Category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {Object.keys(meta?.auditEventCategories ?? {}).map((c) => (
                <SelectItem key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={result} onValueChange={(v) => { setPage(1); setResult(v); }}>
            <SelectTrigger aria-label="Result"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All results</SelectItem>
              <SelectItem value="SUCCESS">Success</SelectItem>
              <SelectItem value="DENIED">Denied</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="Case ID (CASE-…)" className="font-mono text-xs" value={caseId} onChange={(e) => { setPage(1); setCaseId(e.target.value); }} aria-label="Filter by case" />
          <Input placeholder="Evidence ID (EVD-…)" className="font-mono text-xs" value={evidenceId} onChange={(e) => { setPage(1); setEvidenceId(e.target.value); }} aria-label="Filter by evidence" />
          <Input placeholder="Officer ID (OFF-…)" className="font-mono text-xs" value={actorOfficerId} onChange={(e) => { setPage(1); setActorOfficerId(e.target.value); }} aria-label="Filter by officer" />
          <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1">
            <Input type="date" value={dateFrom} onChange={(e) => { setPage(1); setDateFrom(e.target.value); }} aria-label="From date" />
            <Input type="date" value={dateTo} onChange={(e) => { setPage(1); setDateTo(e.target.value); }} aria-label="To date" />
          </div>
          <Select value={eventType} onValueChange={(v) => { setPage(1); setEventType(v); }}>
            <SelectTrigger aria-label="Event type"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">All event types</SelectItem>
              {(meta?.auditEventTypes ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {error ? (
        <ErrorState message={error} />
      ) : !data ? (
        <LoadingState rows={5} />
      ) : data.items.length === 0 ? (
        <EmptyState message="No audit events match the filters." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[34rem] overflow-y-auto rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead className="hidden md:table-cell">Case</TableHead>
                    <TableHead className="hidden lg:table-cell">Resource</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="hidden xl:table-cell">Event hash</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((e: AuditEventRow) => (
                    <TableRow key={e.eventId}>
                      <TableCell className="whitespace-nowrap text-xs">{fmt(e.timestamp)}</TableCell>
                      <TableCell><Badge variant="outline" className="font-mono text-[11px]">{e.eventType}</Badge></TableCell>
                      <TableCell className="text-sm">{e.actor ? e.actor.name : e.actorIdentifier || "System"}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">{e.caseId ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell font-mono text-xs">{e.evidenceId ?? e.documentId ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`${RESULT_STYLES[e.result] ?? ""} text-[11px]`}>{e.result}</Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell font-mono text-xs text-muted-foreground">{shortHash(e.eventHash)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => onOpenEvent(e.eventId)}>View</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server-side pagination (spec §70) */}
      <div className="flex items-center justify-between text-sm">
        <p className="text-muted-foreground">
          {data ? `${data.total} event${data.total === 1 ? "" : "s"} · page ${data.page} of ${totalPages}` : ""}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={!!data && page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Audit event detail (spec §35) — every recorded field incl. both
// hashes; no security secrets exist in the record by design.
// ============================================================

export function AuditDetailView({ eventId, onBack }: { eventId: string; onBack: () => void }) {
  const [event, setEvent] = React.useState<AuditEventRow & { createdAt?: string } | null>(null);
  const [integrity, setIntegrity] = React.useState<{ selfHashValid: boolean; recomputedHash: string; note: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<{ event: AuditEventRow; integrity: { selfHashValid: boolean; recomputedHash: string; note: string } }>(`/api/v1/audit/${eventId}`)
      .then((res) => {
        setEvent(res.event);
        setIntegrity(res.integrity);
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Failed to load the audit event."));
  }, [eventId]);

  if (error) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Back</Button>
        <ErrorState message={error} />
      </div>
    );
  }
  if (!event) return <LoadingState rows={4} />;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Back to audit log</Button>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Audit Event</h1>
        <Badge variant="outline" className="font-mono">{event.eventId}</Badge>
        <Badge variant="outline" className={`${RESULT_STYLES[event.result] ?? ""}`}>{event.result}</Badge>
        <Badge variant="outline" className="text-[11px]">{event.ledgerStatus}</Badge>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Event</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Type</dt><dd><Badge variant="outline" className="font-mono text-[11px]">{event.eventType}</Badge></dd>
            <dt className="text-muted-foreground">Timestamp</dt><dd>{fmt(event.timestamp)}</dd>
            <dt className="text-muted-foreground">Actor</dt>
            <dd>{event.actor ? `${event.actor.name} (${event.actor.officerId})` : event.actorIdentifier ? `${event.actorIdentifier} (unresolved identity)` : "System"}</dd>
            <dt className="text-muted-foreground">Case</dt><dd className="font-mono text-xs">{event.caseId ?? "—"}</dd>
            <dt className="text-muted-foreground">Document</dt><dd className="font-mono text-xs">{event.documentId ?? "—"}</dd>
            <dt className="text-muted-foreground">Evidence</dt><dd className="font-mono text-xs">{event.evidenceId ?? "—"}</dd>
            <dt className="text-muted-foreground">Session</dt><dd className="font-mono text-xs">{event.sessionId ?? "—"}</dd>
            <dt className="text-muted-foreground">IP / device</dt><dd className="font-mono text-xs">{event.ipAddress ?? "—"}{event.userAgent ? ` · ${event.userAgent.slice(0, 60)}` : ""}</dd>
            <dt className="text-muted-foreground">Metadata</dt>
            <dd><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">{event.metadata ? JSON.stringify(event.metadata, null, 2) : "—"}</pre></dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Chain position</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <p className="text-muted-foreground">Previous event hash</p>
            <code className="break-all rounded-md border bg-muted/40 p-2 font-mono text-xs">{event.previousEventHash}</code>
          </div>
          <div>
            <p className="text-muted-foreground">Event hash</p>
            <code className="break-all rounded-md border bg-muted/40 p-2 font-mono text-xs">{event.eventHash}</code>
          </div>
          {integrity && (
            <p className={`rounded-md border p-2 text-xs ${integrity.selfHashValid ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900"}`}>
              Self-hash {integrity.selfHashValid ? "valid" : "INVALID"} — {integrity.note}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
