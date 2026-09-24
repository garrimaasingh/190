"use client";

import * as React from "react";
import {
  api,
  ApiClientError,
  downloadDocument,
  type DocumentDetailResponse,
  type DocumentEventsResponse,
  type DocumentRelationshipsResponse,
  type DocumentRow,
  type Meta,
} from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState, FieldError } from "@/components/platform/common";
import { ClassificationBadge, DocumentStatusBadge, formatBytes, formatDateTime, formatDocDate } from "@/components/platform/DocumentsSection";
import { ArrowLeft, Copy, Download, Eye, FilePlus2, Link2, CheckCircle2 } from "lucide-react";

// ============================================================
// Document details (spec §63) + relationship UI (§9/§40/§62) +
// activity stream (§51). Immutability is communicated concretely
// (spec §53/§92): the SHA-256 fingerprint with Copy Hash — no
// "tamper-proof" theatre.
// ============================================================

type RelatedWorkflow = "SUPPLEMENT" | "CORRECTION" | "REPLACEMENT";

export function DocumentDetailsView({
  caseRef,
  documentId,
  meta,
  onBack,
  onOpenDocument,
  onStartRelated,
  onView,
}: {
  caseRef: string;
  documentId: string;
  meta: Meta | null;
  onBack: () => void;
  onOpenDocument: (documentId: string, mode: "details" | "view") => void;
  onStartRelated: (workflow: RelatedWorkflow, target: DocumentRow) => void;
  onView: () => void;
}) {
  const { me } = useAuth();
  const [detail, setDetail] = React.useState<DocumentDetailResponse | null>(null);
  const [events, setEvents] = React.useState<DocumentEventsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [hashCopied, setHashCopied] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [linkTarget, setLinkTarget] = React.useState("");
  const [linkType, setLinkType] = React.useState("RELATED");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}`;
      const [d, e] = await Promise.all([
        api.get<DocumentDetailResponse>(base),
        api.get<DocumentEventsResponse>(`${base}/events`).catch(() => null),
      ]);
      setDetail(d);
      setEvents(e);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load document.");
    } finally {
      setLoading(false);
    }
  }, [caseRef, documentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const doc = detail?.document;
  const isSystemAdmin = me?.officer.role === "SYSTEM_ADMIN";
  const isAuditor = me?.officer.role === "AUDITOR";
  const canManage = detail?.case.status ? ["DRAFT", "OPEN", "UNDER_INVESTIGATION", "PENDING_FORENSICS", "PENDING_PROSECUTION", "PENDING_COURT"].includes(detail.case.status) && !isAuditor : false;

  async function copyHash() {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.sha256Hash);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 2000);
    } catch {
      setActionError("Could not copy to clipboard.");
    }
  }

  async function handleDownload() {
    if (!doc) return;
    setActionError(null);
    try {
      await downloadDocument(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(doc.id)}/download`,
        doc.originalFilename
      );
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Download failed.");
    }
  }

  async function createLink() {
    if (!doc || !linkTarget) return;
    setActionError(null);
    try {
      await api.post(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(doc.id)}/relationships`,
        { targetDocumentId: linkTarget.trim(), relationshipType: linkType }
      );
      setLinkOpen(false);
      setLinkTarget("");
      await load();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to create relationship.");
    }
  }

  if (loading) return <LoadingState rows={6} />;
  if (error || !detail || !doc) return <ErrorState message={error || "Document not found."} onRetry={load} />;

  const outgoing = detail.relationships.outgoing;
  const incoming = detail.relationships.incoming;
  const correctionOf = outgoing.find((r) => r.relationshipType === "CORRECTION");
  const supplementOf = outgoing.find((r) => r.relationshipType === "SUPPLEMENT");
  const replacedBy = incoming.find((r) => r.relationshipType === "REPLACEMENT");
  const replacementOf = outgoing.find((r) => r.relationshipType === "REPLACEMENT");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-2"><ArrowLeft size={15} aria-hidden /> Back to Case</Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={onView}><Eye size={14} aria-hidden /> View</Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={handleDownload}><Download size={14} aria-hidden /> Download</Button>
        </div>
      </div>

      {/* banners (spec §38/§39) */}
      {correctionOf && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This document is a <strong>correction</strong> associated with{" "}
          <button className="font-mono underline" onClick={() => onOpenDocument(correctionOf.document.documentId, "details")}>
            {correctionOf.document.documentId}
          </button>.
        </p>
      )}
      {supplementOf && (
        <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          This document is a <strong>supplement</strong> to{" "}
          <button className="font-mono underline" onClick={() => onOpenDocument(supplementOf.document.documentId, "details")}>
            {supplementOf.document.documentId}
          </button>.
        </p>
      )}
      {replacedBy && (
        <p className="rounded-md border border-zinc-400 bg-zinc-50 px-3 py-2 text-sm">
          This document has been <strong>replaced</strong> by{" "}
          <button className="font-mono underline" onClick={() => onOpenDocument(replacedBy.document.documentId, "details")}>
            {replacedBy.document.documentId}
          </button>{" "}
          and is preserved as SUPERSEDED.
        </p>
      )}
      {replacementOf && (
        <p className="rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-sm text-teal-900">
          This document is the official <strong>replacement</strong> of{" "}
          <button className="font-mono underline" onClick={() => onOpenDocument(replacementOf.document.documentId, "details")}>
            {replacementOf.document.documentId}
          </button>.
        </p>
      )}
      {doc.status === "QUARANTINED" && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          This document is <strong>QUARANTINED</strong>: it was flagged by the security scan and was never committed as a valid record.
        </p>
      )}

      {/* DOCUMENT INFORMATION (§63) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {doc.title}
            <ClassificationBadge classification={doc.classification} />
            <DocumentStatusBadge status={doc.status} />
          </CardTitle>
          <CardDescription className="font-mono text-xs">{doc.id} · Case {detail.case.caseId}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><span className="block text-xs text-muted-foreground">Document Type</span>{doc.documentType.replaceAll("_", " ")}</div>
          <div><span className="block text-xs text-muted-foreground">Category</span>{doc.documentCategory ? doc.documentCategory.replaceAll("_", " ") : "—"}</div>
          <div className="sm:col-span-2"><span className="block text-xs text-muted-foreground">Description</span>{doc.description || "—"}</div>
        </CardContent>
      </Card>

      {/* FILE INFORMATION */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">File Information</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><span className="block text-xs text-muted-foreground">Original Filename</span>{doc.originalFilename}</div>
          <div><span className="block text-xs text-muted-foreground">MIME Type</span><span className="font-mono text-xs">{doc.mimeType}</span></div>
          <div><span className="block text-xs text-muted-foreground">Size</span>{formatBytes(doc.fileSize)}</div>
          <div><span className="block text-xs text-muted-foreground">Encryption</span>{doc.encryptionStatus === "ENCRYPTED_AES_256_GCM" ? "Encrypted at rest (AES-256-GCM)" : doc.encryptionStatus}</div>
          <div className="sm:col-span-2">
            <span className="block text-xs text-muted-foreground">Integrity Fingerprint (SHA-256)</span>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{doc.sha256Hash}</code>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={copyHash}>
                {hashCopied ? <CheckCircle2 size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {hashCopied ? "Copied" : "Copy Hash"}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              The fingerprint is fixed at commit time. Immutability is enforced by the platform — no API can modify the
              stored content, hash or origin of a committed document.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* CASE + ORIGIN */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Case</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="block text-xs text-muted-foreground">Case ID</span><span className="font-mono">{detail.case.caseId}</span></div>
            <div><span className="block text-xs text-muted-foreground">Case Status</span>{detail.case.status.replaceAll("_", " ")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Origin</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="block text-xs text-muted-foreground">Uploaded By</span>{doc.uploadedBy ? `${doc.uploadedBy.name} (${doc.uploadedBy.officerId})` : "—"}</div>
            <div><span className="block text-xs text-muted-foreground">Department</span>{doc.department?.name || "—"}</div>
            <div><span className="block text-xs text-muted-foreground">Document Date</span>{formatDocDate(doc.documentDate)}</div>
            <div><span className="block text-xs text-muted-foreground">Uploaded At</span>{formatDateTime(doc.uploadedAt)}</div>
            <div><span className="block text-xs text-muted-foreground">Committed At</span>{formatDateTime(doc.committedAt)}</div>
          </CardContent>
        </Card>
      </div>

      {/* METADATA */}
      {doc.metadata && (doc.metadata.referenceNumber || doc.metadata.issuingDepartmentName || doc.metadata.externalReference || (doc.metadata.tags && doc.metadata.tags.length > 0)) && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Recorded Metadata</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {doc.metadata.referenceNumber && <div><span className="block text-xs text-muted-foreground">Reference Number</span>{doc.metadata.referenceNumber}</div>}
            {doc.metadata.issuingDepartmentName && <div><span className="block text-xs text-muted-foreground">Issuing Department</span>{doc.metadata.issuingDepartmentName}</div>}
            {doc.metadata.externalReference && <div><span className="block text-xs text-muted-foreground">External Reference</span>{doc.metadata.externalReference}</div>}
            {doc.metadata.tags && doc.metadata.tags.length > 0 && (
              <div className="sm:col-span-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Tags:</span>
                {doc.metadata.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* RELATIONSHIPS (§63) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Relationships</CardTitle>
            {canManage && doc.status === "COMMITTED" && (
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setLinkOpen(true)}>
                <Link2 size={14} aria-hidden /> Link Document
              </Button>
            )}
          </div>
          <CardDescription>Supplements, corrections and replacements are separate immutable records linked to this one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...incoming, ...outgoing].length === 0 ? (
            <EmptyState title="No related documents." description="Create a supplement, correction or replacement from the actions below." />
          ) : (
            [...incoming, ...outgoing].map((rel) => (
              <div key={rel.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[11px]">{rel.relationshipType}</Badge>
                  <span className="text-xs text-muted-foreground">{rel.direction === "incoming" ? "←" : "→"}</span>
                  <button className="font-medium underline-offset-2 hover:underline" onClick={() => onOpenDocument(rel.document.documentId, "details")}>
                    {rel.document.title}
                  </button>
                  <span className="font-mono text-xs text-muted-foreground">{rel.document.documentId}</span>
                </div>
                <DocumentStatusBadge status={rel.document.status} />
              </div>
            ))
          )}
          {canManage && doc.status === "COMMITTED" && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => onStartRelated("SUPPLEMENT", doc)}><FilePlus2 size={14} aria-hidden /> Add Supplement</Button>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => onStartRelated("CORRECTION", doc)}><FilePlus2 size={14} aria-hidden /> Add Correction</Button>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => onStartRelated("REPLACEMENT", doc)}><FilePlus2 size={14} aria-hidden /> Add Replacement</Button>
            </div>
          )}
          {canManage && doc.status === "SUPERSEDED" && (
            <p className="text-xs text-muted-foreground">This document is superseded — supplements and corrections would target its replacement.</p>
          )}
        </CardContent>
      </Card>

      {/* ACTIVITY (§63 ACTIVITY) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Activity</CardTitle>
          <CardDescription>Created, committed, viewed and downloaded events (access log).</CardDescription>
        </CardHeader>
        <CardContent>
          {!events || events.events.length === 0 ? (
            <EmptyState title="No activity recorded yet." />
          ) : (
            <ol className="space-y-2 text-sm">
              {[...events.events].reverse().map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0">
                  <Badge variant="secondary" className="font-mono text-[11px]">{e.eventType}</Badge>
                  {e.result && <Badge variant="outline" className="text-[11px]">{e.result}</Badge>}
                  <span className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                  {e.actor && <span className="text-xs text-muted-foreground">by {e.actor.name} ({e.actor.officerId})</span>}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* SYSTEM_ADMIN controlled integrity verification (spec §21) */}
      {isSystemAdmin && doc.status !== "QUARANTINED" && (
        <IntegrityVerifier caseRef={caseRef} documentId={doc.id} />
      )}

      {actionError && <FieldError message={actionError} />}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link a related document</DialogTitle>
            <DialogDescription>
              Create a RELATED or REFERENCE link to another document in this case. Supplements, corrections and
              replacements are created through their dedicated actions instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="link-target">Target Document ID</Label>
              <Input id="link-target" value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} placeholder="DOC-MP-IND-2026-000002" />
            </div>
            <div>
              <Label>Relationship Type</Label>
              <Select value={linkType} onValueChange={setLinkType}>
                <SelectTrigger aria-label="Relationship type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RELATED">RELATED</SelectItem>
                  <SelectItem value="REFERENCE">REFERENCE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>Cancel</Button>
            <Button onClick={createLink} disabled={!linkTarget.trim()}>Create Link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Separator className="opacity-0" />
    </div>
  );
}

function IntegrityVerifier({ caseRef, documentId }: { caseRef: string; documentId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ match: boolean; computedHash: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ match: boolean; computedHash: string }>(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}/verify`
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Controlled Integrity Verification</CardTitle>
        <CardDescription>
          Platform-administration process: recomputes the SHA-256 of the stored object and compares it with the
          recorded fingerprint. The check is audited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button size="sm" variant="outline" onClick={verify} disabled={busy}>
          {busy ? "Verifying…" : "Verify stored object"}
        </Button>
        {result && (
          <p className={`text-sm ${result.match ? "text-emerald-700" : "text-red-700"}`} role="status">
            {result.match
              ? "Stored object matches the recorded integrity fingerprint."
              : `MISMATCH — computed ${result.computedHash}. Investigate immediately.`}
          </p>
        )}
        {error && <FieldError message={error} />}
      </CardContent>
    </Card>
  );
}
