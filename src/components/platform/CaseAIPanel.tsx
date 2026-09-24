"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client/api";
import { AIBadge, ConfidenceDisplay, ModelChip, reviewStatusBadge, SourceLink, AIDisclaimer } from "./ai-common";
import { Bot, Sparkles, MessageCircleQuestion, CircleAlert, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

// ============================================================
// CaseAIPanel — "AI Case Intelligence" inside the case dashboard
// (spec §44). Sections: Case Summary / Key Entities / AI Timeline
// / Conflicts / Ask Case. All content obeys server-side
// authorization; AI timeline is displayed SEPARATELY from the
// official case timeline (spec §71).
// ============================================================

interface CaseSummaryData {
  summaries: Array<{ id: string; summaryText: string; latest: boolean; reviewStatus: string; model: { provider: string; modelName: string; modelVersion: string | null }; createdAt: string }>;
}

interface CaseTimelineData {
  timelineEvents: Array<{ id: string; eventDate: string | null; eventDateText: string | null; eventType: string; description: string; document: { documentRef: string; title: string } | null; sourceReference: string | null; confidence: number; reviewStatus: string }>;
  conflicts: Array<{
    id: string; conflictType: string; description: string | null; status: string; resolutionNote: string | null;
    sourceA: { eventRef: string | null; page: string | null; date: string | null; description: string; eventType: string };
    sourceB: { eventRef: string | null; page: string | null; date: string | null; description: string; eventType: string };
  }>;
}

interface AskResponse {
  answer: string;
  sources: Array<{ documentRef: string; documentTitle?: string; pageNumber: number; quote: string }>;
  sufficient: boolean;
  retrievalMethod: string;
  model: { provider: string; modelName: string; modelVersion: string };
  processingMode: string;
  disclaimer?: string;
}

export function CaseAIPanel({
  caseRef,
  canReview,
  onOpenDocument,
}: {
  caseRef: string;
  canReview: boolean;
  onOpenDocument: (documentId: string, mode: "details" | "view") => void;
}) {
  const [summary, setSummary] = React.useState<CaseSummaryData | null>(null);
  const [timeline, setTimeline] = React.useState<CaseTimelineData | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [question, setQuestion] = React.useState("");
  const [askResult, setAskResult] = React.useState<AskResponse | null>(null);
  const [showTimeline, setShowTimeline] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const [s, t] = await Promise.all([
        api.get<CaseSummaryData>(`/api/v1/cases/${encodeURIComponent(caseRef)}/ai/summary`).catch(() => null),
        api.get<CaseTimelineData>(`/api/v1/cases/${encodeURIComponent(caseRef)}/ai/timeline`).catch(() => null),
      ]);
      setSummary(s);
      setTimeline(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load case AI data.");
    }
  }, [caseRef]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function generateSummary() {
    setBusy("summary");
    setError(null);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/ai/summary`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Case summary generation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function generateTimeline() {
    setBusy("timeline");
    setError(null);
    try {
      await api.post(`/api/v1/cases/${encodeURIComponent(caseRef)}/ai/timeline`, {});
      await new Promise((r) => setTimeout(r, 2000));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Timeline extraction failed.");
    } finally {
      setBusy(null);
    }
  }

  async function ask() {
    if (question.trim().length < 3) return;
    setBusy("ask");
    setError(null);
    try {
      const res = await api.post<AskResponse>(`/api/v1/cases/${encodeURIComponent(caseRef)}/ai/ask`, { question: question.trim() });
      setAskResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ask Case failed.");
    } finally {
      setBusy(null);
    }
  }

  async function resolveConflict(conflictId: string, action: "VERIFIED" | "REJECTED") {
    setBusy(conflictId);
    try {
      await api.post(`/api/v1/ai/results/${encodeURIComponent(conflictId)}/review`, { resultType: "TIMELINE_CONFLICT", action });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Conflict resolution failed.");
    } finally {
      setBusy(null);
    }
  }

  const latestSummary = summary?.summaries.find((s) => s.latest);

  return (
    <Card data-testid="case-ai-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot size={18} aria-hidden /> AI Case Intelligence
          <Badge variant="outline" className="text-[10px]">AI-SUGGESTED — separate from the official case timeline</Badge>
        </CardTitle>
        <CardDescription>Assistive intelligence over authorized case material only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-rose-700">
            <CircleAlert size={14} aria-hidden /> {error}
          </p>
        )}

        {/* Case summary */}
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={14} aria-hidden /> Case Summary
              {latestSummary && <AIBadge kind={reviewStatusBadge(latestSummary.reviewStatus)} />}
            </span>
            <Button size="sm" variant="outline" disabled={busy === "summary"} onClick={() => void generateSummary()}>
              {latestSummary ? "Regenerate" : "Generate"}
            </Button>
          </div>
          {busy === "summary" && <p className="mt-2 text-xs text-muted-foreground">Generating from authorized documents…</p>}
          {latestSummary && (
            <div className="mt-2 space-y-1.5">
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs leading-relaxed">{latestSummary.summaryText.slice(0, 2000)}</p>
              <ModelChip provider={latestSummary.model.provider} modelName={latestSummary.model.modelName} modelVersion={latestSummary.model.modelVersion} />
            </div>
          )}
          {!latestSummary && busy !== "summary" && (
            <p className="mt-2 text-xs text-muted-foreground">No case summary yet. Generate one — it uses only documents you are authorized to see.</p>
          )}
        </div>

        {/* AI timeline + conflicts */}
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">AI Timeline &amp; Conflicts</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowTimeline((v) => !v)} aria-expanded={showTimeline}>
                {showTimeline ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {timeline?.timelineEvents.length || 0} suggestion(s)
              </Button>
              <Button size="sm" variant="outline" disabled={busy === "timeline"} onClick={() => void generateTimeline()}>
                Extract timeline
              </Button>
            </div>
          </div>
          {timeline && timeline.conflicts.length > 0 && (
            <div className="mt-2 space-y-2">
              {timeline.conflicts.map((c) => (
                <div key={c.id} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs" data-testid="timeline-conflict">
                  <div className="flex flex-wrap items-center gap-2">
                    <AlertTriangle size={13} aria-hidden className="text-amber-700" />
                    <span className="font-medium text-amber-900">Potential Timeline Conflict — {c.conflictType.replaceAll("_", " ")}</span>
                    <AIBadge kind={reviewStatusBadge(c.status)} />
                  </div>
                  <div className="mt-1 grid gap-1 sm:grid-cols-2">
                    <div>
                      <span className="font-medium">Source A:</span>{" "}
                      {c.sourceA.eventRef && (
                        <SourceLink caseRef={caseRef} documentRef={c.sourceA.eventRef} label={c.sourceA.eventRef} onOpen={(cr, d) => onOpenDocument(d, "view")} />
                      )}{" "}
                      — {c.sourceA.date || "no date"} — {c.sourceA.description.slice(0, 100)}
                    </div>
                    <div>
                      <span className="font-medium">Source B:</span>{" "}
                      {c.sourceB.eventRef && (
                        <SourceLink caseRef={caseRef} documentRef={c.sourceB.eventRef} label={c.sourceB.eventRef} onOpen={(cr, d) => onOpenDocument(d, "view")} />
                      )}{" "}
                      — {c.sourceB.date || "no date"} — {c.sourceB.description.slice(0, 100)}
                    </div>
                  </div>
                  {c.description && <p className="mt-1 text-muted-foreground">{c.description}</p>}
                  {c.status === "UNREVIEWED" && canReview && (
                    <div className="mt-1.5 flex gap-2">
                      <Button size="sm" variant="outline" className="h-7 border-emerald-300 text-emerald-800" disabled={busy === c.id} onClick={() => void resolveConflict(c.id, "VERIFIED")}>Resolve</Button>
                      <Button size="sm" variant="outline" className="h-7 border-rose-300 text-rose-800" disabled={busy === c.id} onClick={() => void resolveConflict(c.id, "REJECTED")}>Dismiss</Button>
                    </div>
                  )}
                  {c.resolutionNote && <p className="mt-1 text-emerald-800">Resolution: {c.resolutionNote}</p>}
                </div>
              ))}
            </div>
          )}
          {showTimeline && (
            <div className="mt-2 space-y-1.5">
              {!timeline?.timelineEvents.length && <p className="text-xs text-muted-foreground">No AI timeline suggestions yet.</p>}
              {timeline?.timelineEvents.map((e) => (
                <div key={e.id} className="rounded-md border bg-muted/30 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{e.eventType}</Badge>
                    <span className="font-medium">{e.eventDate ? new Date(e.eventDate).toISOString().slice(0, 10) : e.eventDateText || "date not parsed"}</span>
                    <AIBadge kind={reviewStatusBadge(e.reviewStatus)} />
                    <ConfidenceDisplay confidence={e.confidence} />
                  </div>
                  <p className="mt-1 text-muted-foreground">{e.description.slice(0, 160)}</p>
                  {e.document && (
                    <SourceLink caseRef={caseRef} documentRef={e.document.documentRef} label={`Source: ${e.document.documentRef}`} onOpen={(cr, d) => onOpenDocument(d, "view")} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Ask Case */}
        <div className="rounded-lg border p-3" data-testid="ask-case">
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageCircleQuestion size={14} aria-hidden /> Ask Case
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Answers are grounded only in authorized case documents, with source references.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder='e.g. "What happened to the seized device?"'
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void ask();
              }}
              aria-label="Ask this case a question"
            />
            <Button onClick={() => void ask()} disabled={busy === "ask"}>
              {busy === "ask" ? "Thinking…" : "Ask"}
            </Button>
          </div>
          {askResult && (
            <div className="mt-3 space-y-2 rounded-md border p-3" data-testid="ask-case-answer">
              <p className="text-sm leading-relaxed">{askResult.answer}</p>
              {askResult.sources.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Sources:</span>
                  {askResult.sources.map((s, i) => (
                    <div key={i} className="text-xs text-muted-foreground">
                      <SourceLink caseRef={caseRef} documentRef={s.documentRef} page={s.pageNumber} onOpen={(cr, d) => onOpenDocument(d, "view")} />
                      {s.quote ? ` — "${s.quote.slice(0, 140)}"` : ""}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <ModelChip provider={askResult.model.provider} modelName={askResult.model.modelName} modelVersion={askResult.model.modelVersion} processingMode={askResult.processingMode === "EXTERNAL" ? "EXTERNAL" : "LOCAL"} />
                <Badge variant="outline" className="text-[10px] capitalize">{askResult.retrievalMethod} retrieval</Badge>
              </div>
              {askResult.disclaimer && <AIDisclaimer>{askResult.disclaimer}</AIDisclaimer>}
            </div>
          )}
        </div>

        <AIDisclaimer />
      </CardContent>
    </Card>
  );
}
