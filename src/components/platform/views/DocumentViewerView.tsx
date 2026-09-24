"use client";

import * as React from "react";
import { api, ApiClientError, downloadDocument, type DocumentDetailResponse } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/platform/common";
import { ClassificationBadge } from "@/components/platform/DocumentsSection";
import { ArrowLeft, Download, Info, FileWarning } from "lucide-react";

// ============================================================
// Secure document viewer (spec §31/§46/§47/§62).
//
// The binary NEVER comes from a storage URL — it is fetched from
// the authorized, event-logged API and materialized client-side:
//   PDF  → sandboxed <iframe> (server also sends CSP sandbox)
//   image → <img>
//   text/csv → rendered as a plain text NODE (never HTML — XSS-safe)
//   else → "Preview unavailable. Authorized download may be available."
// ============================================================

export function DocumentViewerView({
  caseRef,
  documentId,
  onBack,
  onDetails,
}: {
  caseRef: string;
  documentId: string;
  onBack: () => void;
  onDetails: () => void;
}) {
  const [detail, setDetail] = React.useState<DocumentDetailResponse | null>(null);
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
  const [textContent, setTextContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  const doc = detail?.document;

  React.useEffect(() => {
    let revoked: string | null = null;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const d = await api.get<DocumentDetailResponse>(
          `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}`
        );
        setDetail(d);
        const mime = d.document.mimeType;
        if (mime === "text/plain" || mime === "text/csv") {
          // Text is fetched and rendered as a TEXT NODE (XSS-safe).
          const res = await fetch(
            `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}/view`,
            { credentials: "same-origin" }
          );
          if (!res.ok) throw new ApiClientError(res.status, "STREAM_FAILED", `Preview failed (${res.status}).`);
          setTextContent(await res.text());
        } else if (mime !== "application/pdf") {
          // Images (and future embeddable types) via authorized blob fetch.
          const res = await fetch(
            `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}/view`,
            { credentials: "same-origin" }
          );
          if (!res.ok) throw new ApiClientError(res.status, "STREAM_FAILED", `Preview failed (${res.status}).`);
          const blob = await res.blob();
          revoked = URL.createObjectURL(blob);
          setBlobUrl(revoked);
        }
        // application/pdf: the iframe points DIRECTLY at the authorized,
        // event-logged view URL — bytes stream from the API to the built-in
        // renderer, which is isolated by the response CSP sandbox + the
        // frame-level sandbox attribute (spec §31/§46). No storage URLs.
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed.");
      } finally {
        setLoading(false);
      }
    }
    load();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [caseRef, documentId]);

  async function handleDownload() {
    if (!doc) return;
    setDownloadError(null);
    try {
      await downloadDocument(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(doc.id)}/download`,
        doc.originalFilename
      );
    } catch (err) {
      setDownloadError(err instanceof ApiClientError ? err.message : "Download failed.");
    }
  }

  if (loading) return <LoadingState rows={6} label="Retrieving document through secure channel…" />;
  if (error || !doc) {
    return (
      <div className="space-y-3">
        <ErrorState message={error || "Document could not be loaded."} onRetry={onBack} />
        <div className="flex justify-start">
          <Button variant="ghost" onClick={onBack} className="gap-2"><ArrowLeft size={15} aria-hidden /> Back</Button>
        </div>
      </div>
    );
  }

  const mime = doc.mimeType;
  const canEmbed = mime === "application/pdf" || mime.startsWith("image/");
  const isText = mime === "text/plain" || mime === "text/csv";

  return (
    <div className="space-y-3">
      {/* viewer header (§62) */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{doc.title}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{doc.id} · Case {detail!.case.caseId}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClassificationBadge classification={doc.classification} />
          {doc.status !== "COMMITTED" && <span className="text-xs text-muted-foreground">({doc.status})</span>}
          <Button variant="outline" size="sm" className="gap-2" onClick={onDetails}><Info size={14} aria-hidden /> Details</Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={handleDownload}><Download size={14} aria-hidden /> Download</Button>
          <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}><ArrowLeft size={14} aria-hidden /> Back</Button>
        </div>
      </div>

      {downloadError && <p role="alert" className="text-sm text-red-700">{downloadError}</p>}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {doc.status === "QUARANTINED" ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <FileWarning aria-hidden size={32} className="text-red-600" />
              <p className="font-medium">This document is quarantined and cannot be previewed.</p>
            </div>
          ) : canEmbed ? (
            mime === "application/pdf" ? (
              // Controlled rendering (spec §46): the iframe loads the authorized
              // API stream directly (cookie-authenticated, event-logged); the
              // frame sandbox permits the built-in PDF renderer but NOT scripts,
              // and the response is additionally served with CSP sandbox.
              <iframe
                src={`/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentId)}/view`}
                sandbox="allow-same-origin allow-plugins"
                title={`Secure preview of ${doc.title}`}
                className="h-[70vh] w-full bg-white"
                aria-label="Document preview"
              />
            ) : (
              <div className="flex max-h-[70vh] items-center justify-center overflow-auto bg-muted/40 p-4">
                <img src={blobUrl ?? undefined} alt={`Secure preview of ${doc.title}`} className="max-h-[68vh] max-w-full object-contain" />
              </div>
            )
          ) : isText && textContent !== null ? (
            <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">{textContent}</pre>
          ) : (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <FileWarning aria-hidden size={32} className="text-muted-foreground" />
              <p className="font-medium">Preview unavailable.</p>
              <p className="text-sm text-muted-foreground">
                This format ({mime}) cannot be previewed securely. Authorized download may be available.
              </p>
              <Button variant="outline" size="sm" className="gap-2 mt-2" onClick={handleDownload}>
                <Download size={14} aria-hidden /> Download
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
