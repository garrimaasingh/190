"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { AIBadge, ConfidenceDisplay, ModelChip, reviewStatusBadge, SourceLink, AIDisclaimer } from "./ai-common";
import {
  Bot, PlayCircle, RefreshCcw, CircleAlert, ChevronDown, ChevronUp, FileText,
} from "lucide-react";

// ============================================================
// DocumentAIPanel — "AI Intelligence" section inside the document
// details page (spec §43). Sections: Classification / Extracted
// Text / Entities / Summary / Timeline / Related Documents /
// Processing History. Each artifact is labeled with its review
// status and model provenance; source references are openable.
// AI status never blocks normal document access (spec §48).
// ============================================================

interface DocumentAIResponse {
  aiStatus: { status: string; activeJobId: string | null; lastJobId: string | null; lastError: string | null };
  classification: Array<{
    id: string; suggestedType: string; confidence: number; reason: string | null; sourceReference: string | null;
    reviewStatus: string; overrideType: string | null;
    reviewedByOfficer: { officerId: string; name: string } | null; reviewedAt: string | null;
    model: { provider: string; modelName: string; modelVersion: string | null }; createdAt: string;
  }>;
  text: Array<{ pageNumber: number; language: string | null; languageConfidence: number | null; sourceType: string; sourceReference: string | null; extractionConfidence: number | null; chars: number; text: string }>;
  ocr: Array<{ pageNumber: number; language: string | null; confidence: number | null; provider: string; modelVersion: string | null; hasBoundingBoxes: boolean }>;
  entities: Array<{
    id: string; entityType: string; originalText: string; normalizedValue: string | null; pageNumber: number;
    confidence: number; reviewStatus: string;
    source: { documentRef: string; page: number; offset: number | null; snippet: string | null; reference: string | null };
    model: { provider: string; modelName: string; modelVersion: string | null }; createdAt: string;
  }>;
  summaries: Array<{ id: string; summaryType: string; summaryText: string; sourceReferences: Array<{ pageNumber?: number; documentRef?: string; quote?: string }>; reviewStatus: string; model: { provider: string; modelName: string; modelVersion: string | null }; createdAt: string }>;
  timeline: Array<{ id: string; eventDate: string | null; eventDateText: string | null; eventType: string; description: string; sourceReference: string | null; confidence: number; reviewStatus: string; createdAt: string }>;
  relationships: {
    outgoing: Array<{ id: string; relationshipType: string; confidence: number; reason: string | null; status: string; target: { documentId: string; title: string; documentType: string } }>;
    incoming: Array<{ id: string; relationshipType: string; confidence: number; reason: string | null; status: string; source: { documentId: string; title: string; documentType: string } }>;
  };
  jobs: Array<{ jobId: string; jobType: string; status: string; stage: string | null; model: { provider: string | null; modelName: string | null; modelVersion: string | null }; errorCode: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null }>;
}

const STATUS_LABELS: Record<string, string> = {
  AI_NOT_PROCESSED: "AI Not Processed",
  AI_QUEUED: "AI Queued",
  AI_PROCESSING: "AI Processing",
  AI_READY: "AI Ready",
  AI_PARTIALLY_PROCESSED: "AI Partially Processed",
  AI_PROCESSING_FAILED: "AI Processing Failed",
};

export function DocumentAIPanel({
  caseRef,
  documentRef,
  canReview,
  onOpenDocument,
}: {
  caseRef: string;
  documentRef: string;
  canReview: boolean;
  onOpenDocument: (documentId: string, mode: "details" | "view") => void;
}) {
  const [data, setData] = React.useState<DocumentAIResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({ classification: true, entities: true, summary: false, text: false, timeline: false, related: false, jobs: true });

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const d = await api.get<DocumentAIResponse>(`/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentRef)}/ai`);
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI intelligence.");
    }
  }, [caseRef, documentRef]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function startProcessing() {
    setBusy(true);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentRef)}/ai/process`, { jobType: "FULL_ANALYSIS" });
      await new Promise((r) => setTimeout(r, 1200));
      await load();
      // poll briefly so the officer sees progression
      for (let i = 0; i < 8; i++) {
        const s = await api.get<{ status: string }>(`/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(documentRef)}/ai/process`);
        if (s.status !== "AI_QUEUED" && s.status !== "AI_PROCESSING") break;
        await new Promise((r) => setTimeout(r, 1500));
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start AI processing.");
    } finally {
      setBusy(false);
    }
  }

  async function review(resultType: string, resultId: string, action: "VERIFIED" | "REJECTED" | "OVERRIDDEN", overrideType?: string) {
    setBusy(true);
    try {
      await api.post(`/api/v1/ai/results/${encodeURIComponent(resultId)}/review`, { resultType, action, overrideType });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review action failed.");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  if (error && !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-rose-700">
          <CircleAlert size={16} aria-hidden /> {error}
        </CardContent>
      </Card>
    );
  }
  if (!data) return <Skeleton className="h-40" />;

  const latestClassification = data.classification[0];
  const latestSummary = data.summaries.find((s) => s.summaryType === "DETAILED") || data.summaries[0];
  const statusLabel = STATUS_LABELS[data.aiStatus.status] || data.aiStatus.status;

  return (
    <Card data-testid="document-ai-panel">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot size={18} aria-hidden /> AI Intelligence
            </CardTitle>
            <CardDescription>
              {statusLabel}
              {data.aiStatus.activeJobId ? ` — job ${data.aiStatus.activeJobId}` : ""}
              {data.aiStatus.lastError ? ` — ${data.aiStatus.lastError}` : ""}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
              <RefreshCcw size={14} aria-hidden /> Refresh
            </Button>
            <Button size="sm" onClick={() => void startProcessing()} disabled={busy}>
              <PlayCircle size={14} aria-hidden /> {data.aiStatus.status === "AI_NOT_PROCESSED" ? "Start AI Processing" : "Reprocess"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-rose-700">{error}</p>}

        {/* 1. Classification */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("classification")} aria-expanded={openSections.classification}>
            <span className="flex items-center gap-2 text-sm font-medium">1 · Classification</span>
            {openSections.classification ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.classification && (
            <div className="space-y-2 border-t p-3">
              {!latestClassification && <p className="text-sm text-muted-foreground">No classification suggestion yet — start AI processing.</p>}
              {latestClassification && (
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Suggested:</span>
                    <Badge variant="outline" className="font-medium">{latestClassification.suggestedType}</Badge>
                    <AIBadge kind={reviewStatusBadge(latestClassification.reviewStatus)} />
                    <ConfidenceDisplay confidence={latestClassification.confidence} />
                  </div>
                  <ModelChip provider={latestClassification.model.provider} modelName={latestClassification.model.modelName} modelVersion={latestClassification.model.modelVersion} />
                  {latestClassification.reason && <p className="text-xs text-muted-foreground">{latestClassification.reason}</p>}
                  <p className="text-xs text-muted-foreground">
                    The authoritative document type ({documentRef}) never changes automatically — an authorized human decides.
                  </p>
                  {canReview && latestClassification.reviewStatus === "PENDING" && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-800" disabled={busy} onClick={() => void review("CLASSIFICATION", latestClassification.id, "VERIFIED")}>Accept</Button>
                      <Button size="sm" variant="outline" className="border-rose-300 text-rose-800" disabled={busy} onClick={() => void review("CLASSIFICATION", latestClassification.id, "REJECTED")}>Reject</Button>
                      <Button size="sm" variant="outline" className="border-orange-300 text-orange-800" disabled={busy} onClick={() => void review("CLASSIFICATION", latestClassification.id, "OVERRIDDEN", "OTHER")}>Override</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2. Extracted Text */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("text")} aria-expanded={openSections.text}>
            <span className="flex items-center gap-2 text-sm font-medium">
              2 · Extracted Text
              {data.text.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {data.text.length} page(s) · {data.text[0]?.language || "?"} · {data.text[0]?.sourceType}
                </Badge>
              )}
            </span>
            {openSections.text ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.text && (
            <div className="space-y-2 border-t p-3">
              {data.text.length === 0 && <p className="text-sm text-muted-foreground">No extracted text yet.</p>}
              {data.text.map((p) => (
                <details key={p.pageNumber} className="rounded-md border bg-muted/40 p-2">
                  <summary className="cursor-pointer text-xs font-medium">
                    Page {p.pageNumber} — {p.language || "language undetermined"} · {p.sourceType} · {p.chars} chars
                    {p.extractionConfidence != null && p.sourceType === "OCR" ? ` · OCR confidence ${Math.round((p.extractionConfidence || 0) * 100)}%` : ""}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed">{p.text}</pre>
                </details>
              ))}
            </div>
          )}
        </section>

        {/* 3. Entities */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("entities")} aria-expanded={openSections.entities}>
            <span className="flex items-center gap-2 text-sm font-medium">
              3 · Entities
              {data.entities.length > 0 && <Badge variant="secondary" className="text-[10px]">{data.entities.length}</Badge>}
            </span>
            {openSections.entities ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.entities && (
            <div className="space-y-2 border-t p-3">
              {data.entities.length === 0 && <p className="text-sm text-muted-foreground">No entities extracted yet.</p>}
              <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto">
                {data.entities.map((e) => (
                  <div key={e.id} className="rounded-md border p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">{e.entityType}</Badge>
                      <AIBadge kind={reviewStatusBadge(e.reviewStatus)} />
                      <ConfidenceDisplay confidence={e.confidence} />
                    </div>
                    <div className="mt-1 font-medium">
                      {e.originalText}
                      {e.normalizedValue && e.normalizedValue !== e.originalText && <span className="text-muted-foreground"> → {e.normalizedValue}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <SourceLink
                        caseRef={caseRef}
                        documentRef={e.source.documentRef}
                        page={e.source.page}
                        label={e.source.page > 0 ? `Open source — page ${e.source.page}` : "Open source"}
                        onOpen={(c, d) => onOpenDocument(d, "view")}
                      />
                      {canReview && e.reviewStatus === "PENDING" && (
                        <>
                          <button className="font-medium text-emerald-700 underline-offset-2 hover:underline" disabled={busy} onClick={() => void review("ENTITY", e.id, "VERIFIED")}>Verify</button>
                          <button className="font-medium text-rose-700 underline-offset-2 hover:underline" disabled={busy} onClick={() => void review("ENTITY", e.id, "REJECTED")}>Reject</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 4. Summary */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("summary")} aria-expanded={openSections.summary}>
            <span className="flex items-center gap-2 text-sm font-medium">4 · Summary</span>
            {openSections.summary ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.summary && (
            <div className="space-y-2 border-t p-3">
              {!latestSummary && <p className="text-sm text-muted-foreground">No summary generated yet.</p>}
              {latestSummary && (
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{latestSummary.summaryType}</Badge>
                    <AIBadge kind={reviewStatusBadge(latestSummary.reviewStatus)} />
                    <ModelChip provider={latestSummary.model.provider} modelName={latestSummary.model.modelName} modelVersion={latestSummary.model.modelVersion} />
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{latestSummary.summaryText}</p>
                  {latestSummary.sourceReferences.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Sources:</span>
                      {latestSummary.sourceReferences.map((s, i) => (
                        <div key={i} className="text-xs text-muted-foreground">
                          <SourceLink caseRef={caseRef} documentRef={s.documentRef || documentRef} page={s.pageNumber ?? null} onOpen={(c, d) => onOpenDocument(d, "view")} />
                          {s.quote ? ` — "${s.quote.slice(0, 120)}"` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 5. Timeline */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("timeline")} aria-expanded={openSections.timeline}>
            <span className="flex items-center gap-2 text-sm font-medium">
              5 · Timeline (AI-suggested)
              {data.timeline.length > 0 && <Badge variant="secondary" className="text-[10px]">{data.timeline.length}</Badge>}
            </span>
            {openSections.timeline ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.timeline && (
            <div className="space-y-2 border-t p-3">
              {data.timeline.length === 0 && <p className="text-sm text-muted-foreground">No AI timeline suggestions yet. These never become official case events.</p>}
              {data.timeline.map((t) => (
                <div key={t.id} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{t.eventType}</Badge>
                    <span className="font-medium">{t.eventDate ? new Date(t.eventDate).toISOString().slice(0, 10) : t.eventDateText || "date not parsed"}</span>
                    <AIBadge kind={reviewStatusBadge(t.reviewStatus)} />
                    <ConfidenceDisplay confidence={t.confidence} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                  {t.sourceReference && <p className="mt-1 text-[11px] text-muted-foreground">Source: {t.sourceReference}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 6. Related Documents (AI suggestions) */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("related")} aria-expanded={openSections.related}>
            <span className="flex items-center gap-2 text-sm font-medium">
              6 · Related Documents (AI suggestions)
              {data.relationships.outgoing.length + data.relationships.incoming.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">{data.relationships.outgoing.length + data.relationships.incoming.length}</Badge>
              )}
            </span>
            {openSections.related ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.related && (
            <div className="space-y-2 border-t p-3">
              {data.relationships.outgoing.length + data.relationships.incoming.length === 0 && (
                <p className="text-sm text-muted-foreground">No AI relationship suggestions yet. Suggestions never become authoritative relationships automatically.</p>
              )}
              {[...data.relationships.outgoing, ...data.relationships.incoming].map((r) => (
                <div key={r.id} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{r.relationshipType}</Badge>
                    <AIBadge kind={reviewStatusBadge(r.status)} />
                    <ConfidenceDisplay confidence={r.confidence} />
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs">
                    <FileText size={11} aria-hidden />
                    {"target" in r && r.target ? (
                      <button className="underline-offset-2 hover:underline" onClick={() => onOpenDocument(r.target.documentId, "details")}>{r.target.documentId} — {r.target.title}</button>
                    ) : "source" in r && r.source ? (
                      <button className="underline-offset-2 hover:underline" onClick={() => onOpenDocument((r as { source: { documentId: string } }).source.documentId, "details")}>
                        {(r as { source: { documentId: string } }).source.documentId} — {(r as { source: { title: string } }).source.title}
                      </button>
                    ) : null}
                  </div>
                  {r.reason && <p className="mt-1 text-[11px] text-muted-foreground">{r.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 7. Processing History */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between p-3 text-left" onClick={() => toggle("jobs")} aria-expanded={openSections.jobs}>
            <span className="flex items-center gap-2 text-sm font-medium">7 · Processing History</span>
            {openSections.jobs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {openSections.jobs && (
            <div className="space-y-1.5 border-t p-3">
              {data.jobs.length === 0 && <p className="text-sm text-muted-foreground">No AI jobs yet.</p>}
              {data.jobs.map((j) => (
                <div key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                  <span className="font-mono">{j.jobId}</span>
                  <span>{j.jobType}</span>
                  <Badge variant="outline" className="text-[10px]">{j.status}</Badge>
                  <ModelChip provider={j.model.provider} modelName={j.model.modelName} modelVersion={j.model.modelVersion} />
                  <span className="text-muted-foreground">{new Date(j.createdAt).toLocaleString()}</span>
                  {j.errorMessage && <span className="text-rose-700">{j.errorMessage}</span>}
                </div>
              ))}
            </div>
          )}
        </section>

        <AIDisclaimer />
      </CardContent>
    </Card>
  );
}
