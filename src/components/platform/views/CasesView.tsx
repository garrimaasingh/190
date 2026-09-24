"use client";

import * as React from "react";
import { api, ApiClientError, type CaseRow, type IncomingTransferRow } from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/platform/common";
import { EmptyState, ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FolderSearch, Inbox, ArrowRightLeft, Check, X, Eye } from "lucide-react";

// ============================================================
// Case directory (spec §30/§31/§50/§58) + incoming custody
// transfer inbox (spec §21). All authorization is enforced by
// the backend; the UI only mirrors the actions it allows.
// ============================================================

const PRIORITY_STYLES: Record<string, string> = {
  LOW: "bg-zinc-100 text-zinc-800 border-zinc-300",
  NORMAL: "bg-sky-100 text-sky-900 border-sky-300",
  HIGH: "bg-amber-100 text-amber-900 border-amber-300",
  CRITICAL: "bg-red-100 text-red-900 border-red-300",
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge outline className={`${PRIORITY_STYLES[priority] || PRIORITY_STYLES.NORMAL} font-medium`}>
      {priority}
    </Badge>
  );
}

function Badge({ outline, className, children }: { outline?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${outline ? "" : "bg-muted"} ${className || ""}`}
    >
      {children}
    </span>
  );
}

interface Props {
  onOpenCase: (caseId: string) => void;
  onCreateCase: () => void;
}

export function CasesView({ onOpenCase, onCreateCase }: Props) {
  const { me, meta } = useAuth();
  const canCreate = !!me && me.permissions.includes("case.create");

  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [caseType, setCaseType] = React.useState("all");
  const [priority, setPriority] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const pageSize = 10;

  const [data, setData] = React.useState<{ items: CaseRow[]; total: number } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [incoming, setIncoming] = React.useState<IncomingTransferRow[] | null>(null);

  const [decide, setDecide] = React.useState<{ row: IncomingTransferRow; action: "accept" | "reject" } | null>(null);
  const [decideReason, setDecideReason] = React.useState("");
  const [decideError, setDecideError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const loadCases = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search.trim()) params.set("search", search.trim());
      if (status !== "all") params.set("status", status);
      if (caseType !== "all") params.set("caseType", caseType);
      if (priority !== "all") params.set("priority", priority);
      const res = await api.get<{ items: CaseRow[]; total: number }>(`/api/v1/cases?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load cases.");
    } finally {
      setLoading(false);
    }
  }, [search, status, caseType, priority, page]);

  const loadIncoming = React.useCallback(async () => {
    try {
      const res = await api.get<{ items: IncomingTransferRow[] }>("/api/v1/transfers/incoming");
      setIncoming(res.items);
    } catch {
      setIncoming([]);
    }
  }, []);

  React.useEffect(() => {
    const t = setTimeout(loadCases, 250);
    return () => clearTimeout(t);
  }, [loadCases]);

  React.useEffect(() => {
    loadIncoming();
  }, [loadIncoming]);

  async function submitDecision() {
    if (!decide) return;
    if (decide.action === "reject" && decideReason.trim().length < 4) {
      setDecideError("Please provide a brief rejection reason.");
      return;
    }
    setBusy(true);
    setDecideError(null);
    try {
      await api.post(`/api/v1/cases/${decide.row.case.caseId}/transfers/${decide.row.transferId}/${decide.action}`, {
        reason: decideReason.trim() || undefined,
      });
      setDecide(null);
      setDecideReason("");
      await Promise.all([loadIncoming(), loadCases()]);
    } catch (err) {
      setDecideError(err instanceof ApiClientError ? err.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const hasFilters = search.trim() || status !== "all" || caseType !== "all" || priority !== "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-muted-foreground">
            Case directory — authorized cases only. Custody determines which department currently controls a case.
          </p>
        </div>
        {canCreate && (
          <Button onClick={onCreateCase} className="gap-2">
            <FolderSearch size={16} aria-hidden /> New Case
          </Button>
        )}
      </div>

      {/* Incoming custody transfers (destination side, spec §21/§42) */}
      {incoming && incoming.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox aria-hidden size={18} className="text-amber-600" />
              Incoming custody transfers
              <span className="ml-1 rounded-full bg-amber-200 px-2 text-xs font-semibold text-amber-900">
                {incoming.length}
              </span>
            </CardTitle>
            <CardDescription>
              Requests sent to your department. Accepting makes your department the current custodian.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {incoming.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{t.case.title}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{t.case.caseId}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    From <span className="font-medium text-foreground">{t.fromDepartment.name}</span> · Requested by{" "}
                    {t.requestedByOfficer.name} · {new Date(t.requestedAt).toLocaleDateString()}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Reason: {t.reason}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" className="gap-1" onClick={() => { setDecide({ row: t, action: "accept" }); setDecideError(null); }}>
                    <Check size={14} aria-hidden /> Accept
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => { setDecide({ row: t, action: "reject" }); setDecideError(null); }}>
                    <X size={14} aria-hidden /> Reject
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onOpenCase(t.case.caseId)} aria-label={`Open case ${t.case.caseId}`}>
                    <Eye size={14} aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="case-search">Search</Label>
            <Input
              id="case-search"
              placeholder="Case ID, official number or title…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(meta?.caseStatuses || []).map((s) => (
                  <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={caseType} onValueChange={(v) => { setCaseType(v); setPage(1); }}>
              <SelectTrigger aria-label="Filter by case type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(meta?.caseTypes || []).map((t) => (
                  <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(v) => { setPriority(v); setPage(1); }}>
              <SelectTrigger aria-label="Filter by priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {(meta?.casePriorities || []).map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Directory */}
      {loading ? (
        <LoadingState label="Loading cases" rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={loadCases} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={hasFilters ? "No cases match your filters." : "No cases are currently available to you."}
          description={
            hasFilters
              ? "Try adjusting the search or filter criteria."
              : canCreate
                ? "Create your first case to get started."
                : "Cases will appear here once your department participates in one."
          }
          icon={<FolderSearch aria-hidden size={28} />}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case ID</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Custodian</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => onOpenCase(c.caseId)}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{c.caseId}</TableCell>
                      <TableCell className="max-w-56">
                        <p className="truncate font-medium">{c.title}</p>
                        {c.caseNumber && <p className="truncate text-xs text-muted-foreground">Ref: {c.caseNumber}</p>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{c.caseType.replaceAll("_", " ")}</TableCell>
                      <TableCell><PriorityBadge priority={c.priority} /></TableCell>
                      <TableCell><StatusBadge status={c.status} /></TableCell>
                      <TableCell className="max-w-40 whitespace-nowrap text-xs"><span className="truncate">{c.currentCustodianDepartment.name}</span></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(c.updatedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="gap-1" onClick={(e) => { e.stopPropagation(); onOpenCase(c.caseId); }}>
                          <ArrowRightLeft size={13} aria-hidden /> View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {data && data.total > pageSize && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            Page {page} of {totalPages} · {data.total} cases
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {/* Accept / reject confirmation (spec §43) */}
      <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{decide?.action === "accept" ? "Accept custody transfer" : "Reject custody transfer"}</DialogTitle>
            <DialogDescription>
              {decide && (
                <>
                  Case: <span className="font-mono">{decide.row.case.caseId}</span>
                  <br />
                  Current custodian: {decide.row.fromDepartment.name}
                  <br />
                  {decide.action === "accept" ? "New custodian: your department" : "Custody remains unchanged"}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {decide?.action === "accept" && (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm">
              By accepting this transfer, your department becomes the current custodian of the case. This action is
              recorded permanently in the custody history.
            </p>
          )}
          {decide?.action === "reject" && (
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason">Rejection reason (required)</Label>
              <Textarea
                id="reject-reason"
                value={decideReason}
                onChange={(e) => setDecideReason(e.target.value)}
                placeholder="Why is the receiving department declining custody?"
                rows={3}
              />
            </div>
          )}
          <FieldError message={decideError || undefined} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecide(null)}>Cancel</Button>
            <Button onClick={submitDecision} disabled={busy} variant={decide?.action === "accept" ? "default" : "destructive"}>
              {busy ? "Working…" : decide?.action === "accept" ? "Accept Transfer" : "Reject Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
