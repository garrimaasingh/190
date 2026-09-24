"use client";

import * as React from "react";
import {
  api,
  ApiClientError,
  type CaseDetail,
  type DepartmentRef,
  type IncomingTransferRow,
} from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/platform/common";
import { EmptyState, ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { DocumentsSection } from "@/components/platform/DocumentsSection";
import { EvidenceSection } from "@/components/platform/EvidenceSection";
import { CaseAIPanel } from "@/components/platform/CaseAIPanel";
import type { CaseIntegritySummary } from "@/lib/client/api";
import { PriorityBadge } from "@/components/platform/views/CasesView";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Gavel,
  Building2,
  Users,
  ArrowRightLeft,
  History,
  FileText,
  ShieldCheck,
  MapPin,
  CalendarDays,
  UserCircle2,
  Plus,
  UserMinus,
  Trash2,
} from "lucide-react";

// ============================================================
// Case dashboard (spec §26/§41). Sections: Overview, Current
// Custody, Departments, Officers, Custody History, Timeline,
// Documents (Phase 3 empty state), Access. Every action button
// is gated by the server-computed viewer access.
// ============================================================

const PARTICIPATION_LABELS: Record<string, string> = {
  ORIGINATING: "ORIGINATING",
  ACTIVE_CUSTODIAN: "ACTIVE CUSTODIAN",
  PARTICIPATING: "PARTICIPATING",
  CONSULTED: "CONSULTED",
  HISTORICAL: "HISTORICAL",
};

function fmtDate(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function CaseDashboardView({ caseRef, onBack, onUploadDocument, onOpenDocument, onRegisterEvidence, onOpenEvidence }: { caseRef: string; onBack: () => void; onUploadDocument: () => void; onOpenDocument: (documentId: string, mode: "details" | "view") => void; onRegisterEvidence: () => void; onOpenEvidence: (evidenceId: string) => void }) {
  const { me, meta } = useAuth();
  const [detail, setDetail] = React.useState<CaseDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Phase 4 §62: informational integrity summary (documents/evidence/audit/chain).
  const [integrity, setIntegrity] = React.useState<CaseIntegritySummary | null>(null);

  React.useEffect(() => {
    let alive = true;
    api
      .get<CaseIntegritySummary>(`/api/v1/cases/${caseRef}/integrity`)
      .then((s) => { if (alive) setIntegrity(s); })
      .catch(() => { /* informational only */ });
    return () => { alive = false; };
  }, [caseRef]);

  // dialog state
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [addOfficerOpen, setAddOfficerOpen] = React.useState(false);
  const [addDeptOpen, setAddDeptOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [statusChoice, setStatusChoice] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.get<CaseDetail>(`/api/v1/cases/${encodeURIComponent(caseRef)}`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load the case.");
    } finally {
      setLoading(false);
    }
  }, [caseRef]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Loading case" rows={5} />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!detail) return <ErrorState message="Case not found." />;

  const canManage = detail.viewer.manage && detail.mutable;
  const isAcceptedTransfer = (s: string) => s === "ACCEPTED";
  const pendingOutgoing = detail.transfers.find((t) => t.status === "REQUESTED");

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← Back to cases
      </button>

      {/* ---------- CASE HEADER (spec §26/§41) ---------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="font-mono text-sm font-semibold text-muted-foreground">{detail.caseId}</p>
              <h1 className="text-xl font-semibold tracking-tight">{detail.title}</h1>
              {detail.caseNumber && (
                <p className="text-sm text-muted-foreground">Official case number: {detail.caseNumber}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <PriorityBadge priority={detail.priority} />
            </div>
          </div>
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
            <p className="flex items-center gap-2">
              <Building2 aria-hidden size={15} className="text-muted-foreground" />
              <span className="text-muted-foreground">Current custodian:</span>
              <span className="font-medium">{detail.currentCustodianDepartment.name}</span>
            </p>
            <p className="flex items-center gap-2">
              <Gavel aria-hidden size={15} className="text-muted-foreground" />
              <span className="text-muted-foreground">Origin:</span>
              <span className="font-medium">{detail.originatingDepartment.name}</span>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ---------- OVERVIEW ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <p><span className="text-muted-foreground">Case type:</span> {detail.caseType.replaceAll("_", " ")}{detail.caseCategory ? ` · ${detail.caseCategory}` : ""}</p>
          <p><span className="text-muted-foreground">Priority:</span> {detail.priority}</p>
          <p><span className="text-muted-foreground">Status:</span> {detail.status.replaceAll("_", " ")}</p>
          <p><span className="text-muted-foreground">Created by:</span> {detail.createdByOfficer.name} ({detail.createdByOfficer.officerId})</p>
          <p className="flex items-center gap-1.5"><MapPin aria-hidden size={14} className="text-muted-foreground" />{detail.geography.city}, {detail.geography.district}, {detail.geography.state}</p>
          <p className="flex items-center gap-1.5"><CalendarDays aria-hidden size={14} className="text-muted-foreground" />Created: {fmtDate(detail.createdAt)}</p>
          <p className="flex items-center gap-1.5"><CalendarDays aria-hidden size={14} className="text-muted-foreground" />Opened: {fmtDate(detail.openedAt)}</p>
          <p className="flex items-center gap-1.5"><CalendarDays aria-hidden size={14} className="text-muted-foreground" />Last updated: {fmtDate(detail.updatedAt)}</p>
          {detail.description && <p className="sm:col-span-2 rounded-md border bg-muted/30 p-3 text-sm">{detail.description}</p>}
        </CardContent>
      </Card>

      {/* ---------- CURRENT CUSTODY ---------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Current custody</CardTitle>
            <CardDescription>Exactly one department holds custody at any time.</CardDescription>
          </div>
          {detail.viewer.manage && detail.mutable && (
            <Button size="sm" className="gap-2" onClick={() => setTransferOpen(true)} disabled={!!pendingOutgoing}>
              <ArrowRightLeft size={15} aria-hidden /> Transfer Case
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <ShieldCheck aria-hidden size={20} className="text-emerald-600" />
            <div className="min-w-0">
              <p className="font-medium">{detail.currentCustodianDepartment.name}</p>
              <p className="text-xs text-muted-foreground">
                {detail.currentCustodianDepartment.departmentType} · {detail.currentCustodianDepartment.departmentCode}
              </p>
            </div>
            <Badge variant="outline" className="ml-auto border-emerald-300 bg-emerald-100 text-emerald-900">CURRENT CUSTODIAN</Badge>
          </div>
          {detail.currentCustodianOfficer && (
            <p className="flex items-center gap-2 text-sm">
              <UserCircle2 aria-hidden size={15} className="text-muted-foreground" />
              <span className="text-muted-foreground">Responsible officer:</span> {detail.currentCustodianOfficer.name} ({detail.currentCustodianOfficer.officerId})
            </p>
          )}
          {pendingOutgoing && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
              A custody transfer to <strong>{pendingOutgoing.toDepartment.name}</strong> is pending acceptance
              ({pendingOutgoing.transferId}).
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---------- DEPARTMENTS (spec §27/§28) ---------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Departments</CardTitle>
            <CardDescription>Origin, custody and participation are distinct concepts.</CardDescription>
          </div>
          {detail.viewer.manage && detail.mutable && (
            <>
              <Button size="sm" variant="outline" className="gap-2" onClick={() => setAddDeptOpen(true)}>
                <Plus size={15} aria-hidden /> Add Department
              </Button>
              <AddDepartmentDialog
                open={addDeptOpen}
                onOpenChange={setAddDeptOpen}
                detail={detail}
                onDone={() => { setAddDeptOpen(false); load(); }}
                onError={setActionError}
              />
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.participants.length === 0 ? (
            <EmptyState title="No participating departments." />
          ) : (
            detail.participants.map((p) => {
              const label = p.isCustodian
                ? "ACTIVE CUSTODIAN"
                : p.isOrigin
                  ? "ORIGINATING"
                  : PARTICIPATION_LABELS[p.participationType] || p.participationType;
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                  <Building2 aria-hidden size={16} className="text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.department.name}</p>
                    <p className="text-xs text-muted-foreground">{p.department.departmentType} · joined {new Date(p.joinedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        p.isCustodian
                          ? "border-emerald-300 bg-emerald-100 text-emerald-900"
                          : p.isOrigin
                            ? "border-sky-300 bg-sky-100 text-sky-900"
                            : ""
                      }
                    >
                      {label}
                    </Badge>
                    {detail.viewer.manage && detail.mutable && !p.isOrigin && !p.isCustodian && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${p.department.name} from case`}
                        onClick={async () => {
                          setActionError(null);
                          try {
                            await api.del(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/departments/${p.department.id}`);
                            load();
                          } catch (err) {
                            setActionError(err instanceof ApiClientError ? err.message : "Removal failed.");
                          }
                        }}
                      >
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* ---------- OFFICERS (spec §29) ---------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Officers</CardTitle>
            <CardDescription>Officers assigned to this case, by case role.</CardDescription>
          </div>
          {detail.viewer.manage && detail.mutable && (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => setAddOfficerOpen(true)}>
              <Plus size={15} aria-hidden /> Assign Officer
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {detail.officers.filter((o) => o.status === "ACTIVE").length === 0 ? (
            <div className="p-4"><EmptyState title="No officers are assigned to this case." /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Officer ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Case role</TableHead>
                    <TableHead>Assigned</TableHead>
                    {detail.viewer.manage && detail.mutable && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.officers.filter((o) => o.status === "ACTIVE").map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{o.officer.officerId}</TableCell>
                      <TableCell className="font-medium">{o.officer.name}</TableCell>
                      <TableCell className="text-xs">{o.department.name}</TableCell>
                      <TableCell><Badge variant="secondary">{o.roleOnCase.replaceAll("_", " ")}</Badge></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(o.assignedAt).toLocaleDateString()}</TableCell>
                      {detail.viewer.manage && detail.mutable && (
                        <TableCell className="text-right">
                          <RoleChangeButton detail={detail} officerRecordId={o.id} currentRole={o.roleOnCase} onDone={load} onError={setActionError} />
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${o.officer.name} from case`}
                            onClick={async () => {
                              setActionError(null);
                              try {
                                await api.del(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/officers/${o.id}`);
                                load();
                              } catch (err) {
                                setActionError(err instanceof ApiClientError ? err.message : "Removal failed.");
                              }
                            }}
                          >
                            <UserMinus size={14} aria-hidden />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- CUSTODY HISTORY (spec §23/§42) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><History aria-hidden size={17} /> Custody history</CardTitle>
          <CardDescription>Permanent chronological record. Completed transfers cannot be edited or deleted.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.transfers.length === 0 ? (
            <EmptyState title="No custody transfers have been recorded." />
          ) : (
            detail.transfers.map((t) => (
              <div key={t.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{t.transferId}</span>
                  <Badge
                    variant="outline"
                    className={
                      isAcceptedTransfer(t.status)
                        ? "border-emerald-300 bg-emerald-100 text-emerald-900"
                        : t.status === "REQUESTED"
                          ? "border-amber-300 bg-amber-100 text-amber-900"
                          : ""
                    }
                  >
                    {t.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{fmtDate(t.requestedAt)}</span>
                </div>
                <p className="mt-1">
                  <span className="font-medium">{t.fromDepartment.name}</span> → <span className="font-medium">{t.toDepartment.name}</span>
                </p>
                <p className="text-xs text-muted-foreground">Reason: {t.reason}</p>
                <p className="text-xs text-muted-foreground">
                  Requested by {t.requestedByOfficer.name}
                  {t.acceptedByOfficer ? ` · Accepted by ${t.acceptedByOfficer.name}` : ""}
                  {t.acceptedAt ? ` · ${fmtDate(t.acceptedAt)}` : ""}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* ---------- TIMELINE (spec §24/§44) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>Chronological case activity.</CardDescription>
        </CardHeader>
        <CardContent>
          {detail.timeline.length === 0 ? (
            <EmptyState title="No case events recorded yet." />
          ) : (
            <ol className="relative space-y-4 border-l pl-5" aria-label="Case timeline">
              {[...detail.timeline].reverse().map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="font-mono text-[11px]">{e.eventType}</Badge>
                    <span className="text-xs text-muted-foreground">{fmtDate(e.createdAt)}</span>
                  </div>
                  {e.description && <p className="mt-0.5 text-sm">{e.description}</p>}
                  <p className="text-xs text-muted-foreground">
                    {e.actor ? `${e.actor.name} (${e.actor.officerId})` : e.actorIdentifier || "System"}
                    {e.department ? ` · ${e.department}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* ---------- DOCUMENTS (Phase 3, spec §29/§64) ---------- */}
      <DocumentsSection
        caseRef={caseRef}
        meta={meta}
        onUpload={onUploadDocument}
        onOpenDocument={onOpenDocument}
      />

      {/* ---------- EVIDENCE (Phase 4, spec §37) ---------- */}
      <EvidenceSection
        caseRef={caseRef}
        meta={meta}
        onRegister={onRegisterEvidence}
        onOpenEvidence={onOpenEvidence}
      />

      {/* ---------- AI CASE INTELLIGENCE (Phase 5, spec §44) ---------- */}
      <CaseAIPanel
        caseRef={caseRef}
        canReview={!!me?.permissions?.includes("ai.review")}
        onOpenDocument={onOpenDocument}
 />

      {/* ---------- INTEGRITY SUMMARY (Phase 4, spec §62) ---------- */}
      {integrity && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck size={16} className={integrity.chain.valid ? "text-emerald-600" : "text-red-600"} aria-hidden /> Integrity
            </CardTitle>
            <CardDescription>Informational summary of this case&apos;s records and the audit chain state.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <p><span className="text-muted-foreground">Documents:</span> <span className="font-medium">{integrity.documents}</span></p>
            <p><span className="text-muted-foreground">Evidence:</span> <span className="font-medium">{integrity.evidence}</span></p>
            <p>
              <span className="text-muted-foreground">Audit events:</span>{" "}
              <span className="font-medium">{integrity.auditEvents ?? "—"}</span>
              {integrity.auditEventsNote && <span className="block text-xs text-muted-foreground">{integrity.auditEventsNote}</span>}
            </p>
            <p><span className="text-muted-foreground">Custody transfers:</span> <span className="font-medium">{integrity.custodyTransfers}</span></p>
            <p>
              <span className="text-muted-foreground">Chain:</span>{" "}
              <Badge variant="outline" className={integrity.chain.valid ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900"}>
                {integrity.chain.valid ? "VALID" : "INVALID"}
              </Badge>
            </p>
          </CardContent>
        </Card>
      )}

      {/* ---------- ACCESS (spec §14) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your access to this case</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            Access level: <Badge variant="outline">{detail.viewer.level.toUpperCase()}</Badge>
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {detail.viewer.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </CardContent>
      </Card>

      {actionError && <FieldError message={actionError} />}

      {/* ---------- DIALOGS ---------- */}
      {transferOpen && (
        <TransferDialog
          detail={detail}
          onClose={() => setTransferOpen(false)}
          onDone={() => { setTransferOpen(false); load(); }}
        />
      )}
      {addOfficerOpen && (
        <AddOfficerDialog
          open={addOfficerOpen}
          onOpenChange={setAddOfficerOpen}
          detail={detail}
          onDone={() => { setAddOfficerOpen(false); load(); }}
        />
      )}
      {statusOpen && detail.viewer.manage && (
        <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Change case status</DialogTitle>
              <DialogDescription>
                Current status: {detail.status.replaceAll("_", " ")}. Only controlled transitions are permitted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label>New status</Label>
              <Select value={statusChoice} onValueChange={setStatusChoice}>
                <SelectTrigger aria-label="New status"><SelectValue placeholder="Select status" /></SelectTrigger>
                <SelectContent>
                  {detail.allowedTransitions.map((s) => (
                    <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStatusOpen(false)}>Cancel</Button>
              <Button
                disabled={!statusChoice}
                onClick={async () => {
                  setActionError(null);
                  try {
                    await api.patch(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/status`, { status: statusChoice });
                    setStatusOpen(false);
                    setStatusChoice("");
                    load();
                  } catch (err) {
                    setActionError(err instanceof ApiClientError ? err.message : "Status change failed.");
                  }
                }}
              >
                Change Status
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {detail.viewer.manage && detail.mutable && detail.allowedTransitions.length > 0 && (
        <div className="flex justify-end">
          <Button variant="outline" className="gap-2" onClick={() => { setStatusChoice(""); setStatusOpen(true); }}>
            <History size={15} aria-hidden /> Change Status
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------- role change (inline select) ----------------
function RoleChangeButton({
  detail,
  officerRecordId,
  currentRole,
  onDone,
  onError,
}: {
  detail: CaseDetail;
  officerRecordId: string;
  currentRole: string;
  onDone: () => void;
  onError: (m: string | null) => void;
}) {
  const { meta } = useAuth();
  const [role, setRole] = React.useState(currentRole);
  return (
    <Select
      value={role}
      onValueChange={async (v) => {
        setRole(v);
        onError(null);
        try {
          await api.patch(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/officers/${officerRecordId}`, { roleOnCase: v });
          onDone();
        } catch (err) {
          onError(err instanceof ApiClientError ? err.message : "Role change failed.");
        }
      }}
    >
      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Change case role"><SelectValue /></SelectTrigger>
      <SelectContent>
        {(meta?.caseOfficerRoles || []).map((r) => (
          <SelectItem key={r} value={r}>{r.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------- transfer dialog (spec §42) ----------------
function TransferDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: CaseDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [departments, setDepartments] = React.useState<DepartmentRef[]>([]);
  const [officers, setOfficers] = React.useState<{ id: string; name: string; officerId: string; status: string }[]>([]);
  const [toDept, setToDept] = React.useState("");
  const [toOfficer, setToOfficer] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<{ items: DepartmentRef[] }>("/api/v1/departments?page=1&pageSize=100&status=ACTIVE")
      .then((res) => setDepartments(res.items.filter((d) => d.id !== detail.currentCustodianDepartment.id)))
      .catch(() => setError("Failed to load departments."));
  }, [detail.currentCustodianDepartment.id]);

  React.useEffect(() => {
    if (!toDept) return setOfficers([]);
    api
      .get<{ items: { id: string; name: string; officerId: string; status: string }[] }>(
        `/api/v1/cases/${encodeURIComponent(detail.caseId)}/eligible-officers?departmentId=${toDept}&purpose=transfer`
      )
      .then((res) => setOfficers(res.items))
      .catch(() => setOfficers([]));
  }, [toDept, detail.caseId]);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/transfers`, {
        toDepartmentId: toDept,
        toOfficerId: toOfficer || undefined,
        reason: reason.trim(),
        transferNotes: notes.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Transfer request failed.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const valid = !!toDept && reason.trim().length >= 4;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Transfer Case</DialogTitle>
          <DialogDescription>
            Custody changes only after the destination department accepts. Case: <span className="font-mono">{detail.caseId}</span>
          </DialogDescription>
        </DialogHeader>
        {!confirming ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              Current department: <span className="font-medium">{detail.currentCustodianDepartment.name}</span>
            </div>
            <div className="space-y-1.5">
              <Label>Transfer to *</Label>
              <Select value={toDept} onValueChange={(v) => { setToDept(v); setToOfficer(""); }}>
                <SelectTrigger aria-label="Destination department" aria-required="true"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Receiving officer (optional)</Label>
              <Select value={toOfficer} onValueChange={setToOfficer} disabled={!toDept}>
                <SelectTrigger aria-label="Receiving officer"><SelectValue placeholder={toDept ? "Select officer" : "Select a department first"} /></SelectTrigger>
                <SelectContent>
                  {officers.filter((o) => o.status === "ACTIVE").map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.name} ({o.officerId})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-reason">Reason *</Label>
              <Textarea id="transfer-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="Why is custody being transferred?" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-notes">Additional notes</Label>
              <Textarea id="transfer-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} />
            </div>
            <FieldError message={error || undefined} />
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={!valid} onClick={() => setConfirming(true)}>Request Transfer</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border p-3 text-sm">
              <p><span className="text-muted-foreground">Current custodian:</span> {detail.currentCustodianDepartment.name}</p>
              <p><span className="text-muted-foreground">New custodian (pending acceptance):</span> {departments.find((d) => d.id === toDept)?.name}</p>
            </div>
            <p className="text-sm">
              The destination department will receive this request. Custody changes only when they accept it.
            </p>
            <FieldError message={error || undefined} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
              <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit Transfer Request"}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------- assign officer dialog (spec §29) ----------------
function AddOfficerDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: CaseDetail;
  onDone: () => void;
}) {
  const { meta } = useAuth();
  const participantIds = new Set(detail.participants.map((p) => p.department.id));
  const [officers, setOfficers] = React.useState<{ id: string; name: string; officerId: string; status: string; department: { id: string; name: string } }[]>([]);
  const [officerChoice, setOfficerChoice] = React.useState("");
  const [role, setRole] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    Promise.all(
      Array.from(participantIds).map((deptId) =>
        api
          .get<{ items: typeof officers }>(
            `/api/v1/cases/${encodeURIComponent(detail.caseId)}/eligible-officers?departmentId=${deptId}&purpose=assign`
          )
          .then((res) => res.items)
          .catch(() => [])
      )
    ).then((lists) => {
      const assigned = new Set(detail.officers.filter((o) => o.status === "ACTIVE").map((o) => o.officer.id));
      setOfficers(lists.flat().filter((o) => o.status === "ACTIVE" && !assigned.has(o.id)));
    });
  }, [open]);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/officers`, {
        officerId: officerChoice,
        roleOnCase: role,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Assignment failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign officer</DialogTitle>
          <DialogDescription>Only active officers of participating departments can be assigned.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Officer *</Label>
            <Select value={officerChoice} onValueChange={setOfficerChoice}>
              <SelectTrigger aria-label="Officer" aria-required="true"><SelectValue placeholder="Select officer" /></SelectTrigger>
              <SelectContent>
                {officers.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name} ({o.officerId}) — {o.department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Case role *</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger aria-label="Case role" aria-required="true"><SelectValue placeholder="Select role" /></SelectTrigger>
              <SelectContent>
                {(meta?.caseOfficerRoles || []).map((r) => (
                  <SelectItem key={r} value={r}>{r.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FieldError message={error || undefined} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!officerChoice || !role || busy} onClick={submit}>{busy ? "Assigning…" : "Assign"}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- add department dialog (spec §12) ----------------
function AddDepartmentDialog({
  open,
  onOpenChange,
  detail,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: CaseDetail;
  onDone: () => void;
  onError: (m: string | null) => void;
}) {
  const { meta } = useAuth();
  const [departments, setDepartments] = React.useState<DepartmentRef[]>([]);
  const [deptChoice, setDeptChoice] = React.useState("");
  const [pType, setPType] = React.useState("PARTICIPATING");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api
      .get<{ items: DepartmentRef[] }>("/api/v1/departments?page=1&pageSize=100&status=ACTIVE")
      .then((res) => {
        const existing = new Set(detail.participants.map((p) => p.department.id));
        setDepartments(res.items.filter((d) => !existing.has(d.id)));
      })
      .catch(() => setError("Failed to load departments."));
  }, [open]);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(detail.caseId)}/departments`, {
        departmentId: deptChoice,
        participationType: pType,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add department.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users aria-hidden size={16} /> Add department</DialogTitle>
          <DialogDescription>
            Add a participating or consulted department. Custody changes only through the transfer workflow.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Department *</Label>
            <Select value={deptChoice} onValueChange={setDeptChoice}>
              <SelectTrigger aria-label="Department" aria-required="true"><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Participation type</Label>
            <Select value={pType} onValueChange={setPType}>
              <SelectTrigger aria-label="Participation type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(meta?.participationTypes || ["PARTICIPATING", "CONSULTED"])
                  .filter((t) => t === "PARTICIPATING" || t === "CONSULTED")
                  .map((t) => (
                    <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <FieldError message={error || undefined} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!deptChoice || busy} onClick={submit}>{busy ? "Adding…" : "Add Department"}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Keep the incoming-transfer type referenced for future dashboard cards.
export type { IncomingTransferRow };
