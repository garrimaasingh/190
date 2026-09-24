"use client";

import * as React from "react";
import {
  api,
  ApiClientError,
  downloadDocument,
  type EvidenceRow,
  type EvidenceRelationshipRow,
  type CustodyChainResponse,
  type Meta,
} from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, FieldError, LoadingState } from "@/components/platform/common";
import { ClassificationBadge } from "@/components/platform/DocumentsSection";
import { EvidenceStatusBadge } from "@/components/platform/EvidenceSection";
import { ArrowDown, ArrowLeft, Copy, Download as DownloadIcon, Eye, Link2, ShieldCheck, Send } from "lucide-react";

// ============================================================
// Evidence details (spec §63/§64/§40):
//  - identity + acquisition + current custody
//  - integrity block (algorithm, fingerprint with copy, storage state)
//  - relationships to documents (spec §20)
//  - full chain of custody with explicit text + timestamps (§64)
//  - controlled actions: status change, custody transfer, download
// The hash is an integrity reference, NOT an admissibility claim.
// ============================================================

function fmt(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface EvidenceDetailsViewProps {
  caseRef: string;
  evidenceId: string;
  meta: Meta | null;
  onBack: () => void;
  onOpenDocument?: (documentId: string, mode: "details" | "view") => void;
}

export function EvidenceDetailsView({ caseRef, evidenceId, meta, onBack, onOpenDocument }: EvidenceDetailsViewProps) {
  const { me } = useAuth();
  const [evidence, setEvidence] = React.useState<EvidenceRow | null>(null);
  const [relationships, setRelationships] = React.useState<EvidenceRelationshipRow[]>([]);
  const [custody, setCustody] = React.useState<CustodyChainResponse | null>(null);
  const [custodianIsMe, setCustodianIsMe] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [transferOpen, setTransferOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ evidence: EvidenceRow; relationships: EvidenceRelationshipRow[]; custodianIsMe: boolean }>(
        `/api/v1/cases/${caseRef}/evidence/${evidenceId}`
      );
      setEvidence(res.evidence);
      setRelationships(res.relationships);
      setCustodianIsMe(res.custodianIsMe);
      const chain = await api.get<CustodyChainResponse>(`/api/v1/cases/${caseRef}/evidence/${evidenceId}/transfers`);
      setCustody(chain);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load evidence.");
    }
  }, [caseRef, evidenceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const [copied, setCopied] = React.useState(false);
  async function copyHash() {
    if (!evidence?.sha256Hash) return;
    try {
      await navigator.clipboard.writeText(evidence.sha256Hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError("Clipboard unavailable — select the hash manually.");
    }
  }

  if (error) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Back to case</Button>
        <ErrorState message={error} />
      </div>
    );
  }
  if (!evidence) {
    return <LoadingState rows={4} />;
  }

  const role = me?.officer.role;
  const canManage = custodianIsMe && (role === "SYSTEM_ADMIN" || role === "DEPARTMENT_ADMIN" || role === "OFFICER");
  const liveStatus = ["REGISTERED", "COLLECTED", "IN_CUSTODY", "TRANSFERRED", "UNDER_EXAMINATION"];
  const statusOptions = (meta?.evidenceStatusTransitions?.[evidence.status] ?? []).filter((s) => s !== "TRANSFER_PENDING");

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Back to case</Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{evidence.title}</h1>
          <Badge variant="outline" className="font-mono text-xs">{evidence.id}</Badge>
          <EvidenceStatusBadge status={evidence.status} />
        </div>
      </div>

      {notice && <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900">{notice}</p>}
      {actionError && <FieldError message={actionError} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- Identity & acquisition (spec §63) ---------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Evidence record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">Case</dt>
              <dd className="font-mono text-xs">{evidence.caseId}</dd>
              <dt className="text-muted-foreground">Type / category</dt>
              <dd>{evidence.evidenceType.replaceAll("_", " ")}{evidence.category ? ` · ${evidence.category}` : ""}</dd>
              <dt className="text-muted-foreground">Classification</dt>
              <dd><ClassificationBadge classification={evidence.classification} /></dd>
              <dt className="text-muted-foreground">External number</dt>
              <dd>{evidence.evidenceNumber ?? "—"}</dd>
              <dt className="text-muted-foreground">Source</dt>
              <dd>{evidence.sourceType.replaceAll("_", " ")}{evidence.sourceReference ? ` · ${evidence.sourceReference}` : ""}</dd>
              <dt className="text-muted-foreground">Collected</dt>
              <dd>{fmt(evidence.collectedAt)}{evidence.collectionLocation ? ` · ${evidence.collectionLocation}` : ""}</dd>
              <dt className="text-muted-foreground">Collected by</dt>
              <dd>
                {evidence.collectedByOfficer ? `${evidence.collectedByOfficer.name} (${evidence.collectedByOfficer.officerId})` : "—"}
                {evidence.collectingDepartment ? ` · ${evidence.collectingDepartment.name}` : ""}
              </dd>
              <dt className="text-muted-foreground">Condition</dt>
              <dd>{evidence.condition ?? "—"}</dd>
              {evidence.deviceMetadata && (
                <>
                  <dt className="text-muted-foreground">Device metadata</dt>
                  <dd className="font-mono text-xs">{Object.entries(evidence.deviceMetadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Committed</dt>
              <dd>{fmt(evidence.committedAt)}</dd>
            </dl>
            {evidence.description && <p className="rounded-md border bg-muted/30 p-2 text-muted-foreground">{evidence.description}</p>}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* ---------- Current custody ---------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Current custody</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <p className="font-medium">{custody?.currentCustodian?.department ?? evidence.currentCustodianDepartment?.name ?? "—"}</p>
              <p className="text-muted-foreground">
                {custody?.currentCustodian?.officer ?? evidence.currentCustodianOfficer?.name ?? "Department-level custody"}
              </p>
            </CardContent>
          </Card>

          {/* ---------- Integrity (spec §40) ---------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Integrity</CardTitle>
              <CardDescription>Concrete controls only — the fingerprint is an integrity reference, not proof of admissibility.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {evidence.hasDigitalContent ? (
                <>
                  <p><span className="text-muted-foreground">Integrity algorithm:</span> <span className="font-medium">{evidence.hashAlgorithm}</span></p>
                  <div>
                    <p className="text-muted-foreground">Integrity fingerprint (SHA-256):</p>
                    <div className="mt-1 flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 p-2 font-mono text-xs">{evidence.sha256Hash}</code>
                      <Button variant="outline" size="sm" onClick={copyHash} aria-label="Copy integrity fingerprint">
                        <Copy size={14} aria-hidden /> {copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                  <p>
                    <span className="text-muted-foreground">Storage:</span> <span className="font-medium">SECURE</span>
                    <span className="text-muted-foreground"> · encrypted at rest ({evidence.encryptionStatus})</span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    <span className="font-medium">{evidence.status === "ARCHIVED" ? "VERIFICATION REQUIRED" : "VALID"}</span>
                    <span className="block text-xs text-muted-foreground">
                      The stored object is immutable (no mutation or delete API exists). Integrity can be re-verified by the platform administrator against the frozen fingerprint.
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        downloadDocument(
                          `/api/v1/cases/${caseRef}/evidence/${evidence.id}/download`,
                          evidence.originalFilename || evidence.id
                        ).catch(() => setActionError("Download failed — you may not be authorized."))
                      }
                    >
                      <DownloadIcon size={14} aria-hidden /> Download
                    </Button>
                    {["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"].includes(evidence.mimeType ?? "") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/v1/cases/${caseRef}/evidence/${evidence.id}/view`, { credentials: "same-origin" });
                            if (!res.ok) throw new Error();
                            const blob = await res.blob();
                            const url = URL.createObjectURL(blob);
                            window.open(url, "_blank", "noopener");
                            setTimeout(() => URL.revokeObjectURL(url), 30000);
                          } catch {
                            setActionError("Secure preview failed.");
                          }
                        }}
                      >
                        <Eye size={14} aria-hidden /> View
                      </Button>
                    )}
                    {evidence.mimeType && !["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"].includes(evidence.mimeType) && (
                      <p className="w-full text-xs text-muted-foreground">Preview unavailable for {evidence.mimeType} — use download.</p>
                    )}
                    {role === "SYSTEM_ADMIN" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setActionError(null);
                          try {
                            const res = await api.post<{ verificationResult: string }>(`/api/v1/cases/${caseRef}/evidence/${evidence.id}/verify`);
                            setNotice(`Integrity verification: ${res.verificationResult}. The attempt itself is recorded in the audit ledger.`);
                          } catch (err) {
                            setActionError(err instanceof ApiClientError ? err.message : "Verification failed.");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <ShieldCheck size={14} aria-hidden /> Verify integrity
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Physical evidence — no digital content, so there is no content fingerprint. Integrity is maintained
                  through the immutable custody records below.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---------- Chain of custody (spec §64) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Chain of custody</CardTitle>
          <CardDescription>
            Chronological and immutable — every entry names the actor, department, timestamp and outcome. Corrections
            would be new records, never edits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!custody ? (
            <LoadingState rows={2} />
          ) : (
            <ol className="space-y-0">
              {custody.chain.map((c, i) => (
                <li key={i} className="relative pb-4 pl-6 last:pb-0">
                  {i < custody.chain.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-border" aria-hidden />}
                  <span className="absolute left-0 top-1 flex h-4 w-4 items-center justify-center rounded-full border bg-background" aria-hidden>
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[11px]">{c.action}</Badge>
                    <span className="text-xs text-muted-foreground">{fmt(c.timestamp)}</span>
                  </div>
                  <p className="mt-0.5 text-sm">
                    {c.kind === "COLLECTED" ? (
                      <>Collected / registered — {c.actorDepartment ?? "—"}{c.actorOfficer ? ` · ${c.actorOfficer}` : ""}</>
                    ) : (
                      <>
                        {c.fromDepartment ?? "—"} → {c.toDepartment ?? "—"}
                        {c.actorOfficer ? ` · decided by ${c.actorOfficer}` : ""}
                      </>
                    )}
                  </p>
                  {c.detail && typeof c.detail === "object" && "reason" in c.detail && (
                    <p className="text-xs text-muted-foreground">Reason: {String(c.detail.reason)}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {canManage && liveStatus.includes(evidence.status) && (
            <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>Change status</Button>
              <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}>
                <Send size={14} aria-hidden /> Transfer custody
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
                <Link2 size={14} aria-hidden /> Link document
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- Relationships (spec §20/§63) ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Related documents</CardTitle>
          <CardDescription>
            Direction is document → evidence (e.g. a forensic report DESCRIBES this item). Not a knowledge graph.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {relationships.length === 0 ? (
            <EmptyState message="No documents are linked to this evidence yet." />
          ) : (
            <ul className="space-y-2">
              {relationships.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => onOpenDocument?.(r.document.documentId, "details")}
                    >
                      {r.document.title}
                    </button>
                    <span className="block font-mono text-xs text-muted-foreground">{r.document.documentId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-mono text-[11px]">{r.relationshipType}</Badge>
                    <ClassificationBadge classification={r.document.classification} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------- Status dialog ---------- */}
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent className="sm:max-w-md">
          <StatusDialog
            caseRef={caseRef}
            evidence={evidence}
            statusOptions={statusOptions}
            onClose={() => setStatusOpen(false)}
            onDone={() => { setStatusOpen(false); setNotice("Status changed — the change and its audit event were committed together."); void load(); }}
            onFail={(m) => setActionError(m)}
          />
        </DialogContent>
      </Dialog>

      {/* ---------- Transfer dialog ---------- */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <TransferDialog
            caseRef={caseRef}
            evidence={evidence}
            onClose={() => setTransferOpen(false)}
            onDone={() => { setTransferOpen(false); setNotice("Transfer requested — the receiving department must accept before custody changes."); void load(); }}
            onFail={(m) => setActionError(m)}
          />
        </DialogContent>
      </Dialog>

      {/* ---------- Link document dialog ---------- */}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <LinkDialog
            caseRef={caseRef}
            evidence={evidence}
            meta={meta}
            onClose={() => setLinkOpen(false)}
            onDone={() => { setLinkOpen(false); setNotice("Document linked — the relationship is recorded in the audit ledger."); void load(); }}
            onFail={(m) => setActionError(m)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------- dialogs ----------------

function StatusDialog({
  caseRef, evidence, statusOptions, onClose, onDone, onFail,
}: {
  caseRef: string;
  evidence: EvidenceRow;
  statusOptions: string[];
  onClose: () => void;
  onDone: () => void;
  onFail: (m: string) => void;
}) {
  const [status, setStatus] = React.useState(statusOptions[0] ?? "");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base">Change evidence status</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Current status: <span className="font-medium text-foreground">{evidence.status}</span>. Only permitted transitions are listed.</p>
        <div className="space-y-1.5">
          <Label htmlFor="st-status">New status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="st-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusOptions.map((s) => <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-reason">Reason (recorded in audit)</Label>
          <Textarea id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          disabled={!status || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(`/api/v1/cases/${caseRef}/evidence/${evidence.id}/status`, { status, reason: reason || undefined });
              onDone();
            } catch (err) {
              onFail(err instanceof ApiClientError ? err.message : "Status change failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}

function TransferDialog({
  caseRef, evidence, onClose, onDone, onFail,
}: {
  caseRef: string;
  evidence: EvidenceRow;
  onClose: () => void;
  onDone: () => void;
  onFail: (m: string) => void;
}) {
  const [departments, setDepartments] = React.useState<{ id: string; name: string }[]>([]);
  const [toDepartmentId, setToDepartmentId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // The case-departments route returns participation rows with the
    // nested department object + isCustodian flag — extract participants
    // other than the item's current custodian (spec §44 rule 5).
    api
      .get<{ items: { department: { id: string; name: string }; isCustodian: boolean }[] }>(
        `/api/v1/cases/${caseRef}/departments`
      )
      .then((res) =>
        setDepartments(
          res.items
            .filter((d) => !d.isCustodian)
            .map((d) => ({ id: d.department.id, name: d.department.name }))
        )
      )
      .catch(() => setLocalError("Could not load case departments."));
  }, [caseRef]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base">Transfer evidence custody</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The item moves to the receiving department only after THEY accept. Case custody is unaffected — evidence
          custody is tracked independently.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="tr-dept">Receiving department (case participant)</Label>
          <Select value={toDepartmentId} onValueChange={setToDepartmentId}>
            <SelectTrigger id="tr-dept"><SelectValue placeholder="Select department" /></SelectTrigger>
            <SelectContent>
              {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tr-reason">Reason</Label>
          <Textarea id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} placeholder="Why is this item being transferred?" />
        </div>
        {localError && <FieldError message={localError} />}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          disabled={!toDepartmentId || reason.trim().length < 4 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(`/api/v1/cases/${caseRef}/evidence/${evidence.id}/transfers`, { toDepartmentId, reason });
              onDone();
            } catch (err) {
              onFail(err instanceof ApiClientError ? err.message : "Transfer request failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Request transfer
        </Button>
      </DialogFooter>
    </>
  );
}

function LinkDialog({
  caseRef, evidence, meta, onClose, onDone, onFail,
}: {
  caseRef: string;
  evidence: EvidenceRow;
  meta: Meta | null;
  onClose: () => void;
  onDone: () => void;
  onFail: (m: string) => void;
}) {
  const [documents, setDocuments] = React.useState<{ documentId: string; title: string }[]>([]);
  const [documentId, setDocumentId] = React.useState("");
  const [relationshipType, setRelationshipType] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<{ items: { documentId: string; title: string }[] }>(`/api/v1/cases/${caseRef}/documents?pageSize=100`)
      .then((res) => setDocuments(res.items))
      .catch(() => setLocalError("Could not load case documents."));
  }, [caseRef]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base">Link a document to this evidence</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <Label htmlFor="ln-doc">Document (this case only)</Label>
          <Select value={documentId} onValueChange={setDocumentId}>
            <SelectTrigger id="ln-doc"><SelectValue placeholder="Select document" /></SelectTrigger>
            <SelectContent>
              {documents.map((d) => <SelectItem key={d.documentId} value={d.documentId}>{d.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ln-type">Relationship</Label>
          <Select value={relationshipType} onValueChange={setRelationshipType}>
            <SelectTrigger id="ln-type"><SelectValue placeholder="Select type" /></SelectTrigger>
            <SelectContent>
              {(meta?.evidenceRelationshipTypes ?? []).map((t) => (
                <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}{meta?.evidenceRelationshipNotes?.[t] ? ` — ${meta.evidenceRelationshipNotes[t]}` : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Direction: the document → this evidence.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ln-note">Note</Label>
          <Input id="ln-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </div>
        {localError && <FieldError message={localError} />}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          disabled={!documentId || !relationshipType || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(`/api/v1/cases/${caseRef}/evidence/${evidence.id}/relationships`, { documentId, relationshipType, note: note || undefined });
              onDone();
            } catch (err) {
              onFail(err instanceof ApiClientError ? err.message : "Linking failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Link document
        </Button>
      </DialogFooter>
    </>
  );
}
