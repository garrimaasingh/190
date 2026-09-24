"use client";

import * as React from "react";
import {
  api,
  downloadDocument,
  ApiClientError,
  type DocumentListResponse,
  type DocumentRow,
  type Meta,
} from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingState } from "@/components/platform/common";
import { Eye, Download as DownloadIcon, Info, FilePlus2, FileText, Lock } from "lucide-react";

// ============================================================
// Documents section of the case dashboard (spec §29/§41/§64).
// The table renders ONLY rows the server returned — authorization
// and classification filtering happen in the query (spec §64).
// Actions shown are those the viewer can actually perform.
// ============================================================

export const CLASSIFICATION_STYLES: Record<string, string> = {
  PUBLIC: "bg-zinc-100 text-zinc-800 border-zinc-300",
  INTERNAL: "bg-sky-100 text-sky-900 border-sky-300",
  CONFIDENTIAL: "bg-amber-100 text-amber-900 border-amber-300",
  RESTRICTED: "bg-orange-100 text-orange-900 border-orange-300",
  HIGHLY_RESTRICTED: "bg-red-100 text-red-900 border-red-300",
};

export function ClassificationBadge({ classification }: { classification: string }) {
  return (
    <Badge variant="outline" className={`${CLASSIFICATION_STYLES[classification] || ""} font-medium`}>
      {classification.replaceAll("_", " ")}
    </Badge>
  );
}

export function DocumentStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMMITTED: "bg-emerald-100 text-emerald-900 border-emerald-300",
    SUPERSEDED: "bg-zinc-200 text-zinc-800 border-zinc-400",
    QUARANTINED: "bg-red-100 text-red-900 border-red-300",
    ARCHIVED: "bg-zinc-100 text-zinc-600 border-zinc-300",
  };
  return (
    <Badge variant="outline" className={`${styles[status] || ""} font-medium`}>
      {status}
    </Badge>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDocDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function DocumentsSection({
  caseRef,
  meta,
  onUpload,
  onOpenDocument,
}: {
  caseRef: string;
  meta: Meta | null;
  onUpload: () => void;
  onOpenDocument: (documentId: string, mode: "details" | "view") => void;
}) {
  const { me } = useAuth();
  const [data, setData] = React.useState<DocumentListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  // filters
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState("");
  const [classification, setClassification] = React.useState("");
  const [status, setStatus] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (type) params.set("type", type);
      if (classification) params.set("classification", classification);
      if (status) params.set("status", status);
      const res = await api.get<DocumentListResponse>(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents?${params.toString()}`
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load documents.");
    } finally {
      setLoading(false);
    }
  }, [caseRef, q, type, classification, status]);

  React.useEffect(() => {
    const t = setTimeout(load, 250); // debounce search typing
    return () => clearTimeout(t);
  }, [load]);

  const isAuditor = me?.officer.role === "AUDITOR";

  async function handleDownload(doc: DocumentRow) {
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText aria-hidden size={17} /> Documents
            </CardTitle>
            <CardDescription className="mt-1 flex items-center gap-1.5">
              <Lock aria-hidden size={12} /> Encrypted storage · immutable records · integrity fingerprints
            </CardDescription>
          </div>
          {data?.canUpload && (
            <Button size="sm" className="gap-2" onClick={onUpload}>
              <FilePlus2 size={15} aria-hidden /> Upload Document
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, filename, document ID…"
            aria-label="Search documents"
            className="w-full sm:w-64"
          />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger aria-label="Filter by type" className="w-full sm:w-44">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL_TYPES">All types</SelectItem>
              {(meta?.documentTypes || []).map((t) => (
                <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={classification} onValueChange={setClassification}>
            <SelectTrigger aria-label="Filter by classification" className="w-full sm:w-44">
              <SelectValue placeholder="All classifications" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL_CLASSIFICATIONS">All classifications</SelectItem>
              {(meta?.documentClassifications || []).map((c) => (
                <SelectItem key={c} value={c}>{c.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL_STATUSES">All statuses</SelectItem>
              {["COMMITTED", "SUPERSEDED", "QUARANTINED"].map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {downloadError && (
          <p role="alert" className="text-sm text-red-700">{downloadError}</p>
        )}

        {loading ? (
          <LoadingState rows={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No documents have been added to this case yet."
            description={
              data?.canUpload
                ? "Upload the first document — it will be validated, hashed, encrypted and committed as an immutable record."
                : "Documents added by the case custodian will appear here according to your access."
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Classification</TableHead>
                  <TableHead>Uploaded By</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((doc) => (
                  <TableRow key={doc.id} data-document-id={doc.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{doc.id}</TableCell>
                    <TableCell className="max-w-52">
                      <p className="truncate font-medium" title={doc.title}>{doc.title}</p>
                      <p className="truncate text-xs text-muted-foreground" title={doc.originalFilename}>
                        {doc.originalFilename} · {formatBytes(doc.fileSize)}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{doc.documentType.replaceAll("_", " ")}</TableCell>
                    <TableCell><ClassificationBadge classification={doc.classification} /></TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{doc.uploadedBy?.name || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{doc.department?.name || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDocDate(doc.documentDate || doc.uploadedAt)}</TableCell>
                    <TableCell><DocumentStatusBadge status={doc.status} /></TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="sm" className="h-8 gap-1.5"
                          onClick={() => onOpenDocument(doc.id, "view")}
                          aria-label={`View ${doc.title}`}
                        >
                          <Eye size={14} aria-hidden /> View
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-8 gap-1.5"
                          onClick={() => handleDownload(doc)}
                          aria-label={`Download ${doc.title}`}
                        >
                          <DownloadIcon size={14} aria-hidden /> Download
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-8 gap-1.5"
                          onClick={() => onOpenDocument(doc.id, "details")}
                          aria-label={`Details of ${doc.title}`}
                        >
                          <Info size={14} aria-hidden /> Details
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {isAuditor && data && data.items.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Auditor visibility: read-only access up to RESTRICTED classification.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
