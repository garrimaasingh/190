"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { AIBadge, ModelChip, AIDisclaimer } from "../ai-common";
import { Bot, RefreshCcw, FileSearch, CircleAlert, Settings2 } from "lucide-react";

// ============================================================
// AIDashboardView — /ai (spec §42) + administrative configuration
// (spec §56, SYSTEM_ADMIN only) + transparency panel (spec §38).
// ============================================================

interface DashboardData {
  processing: {
    queued: number;
    processingNow: number;
    completed: number;
    partial: number;
    failed: number;
    cancelled: number;
    documentsProcessed: number;
  };
  intelligence: {
    ocrResults: number;
    classificationSuggestionsPending: number;
    entitiesPendingReview: number;
    summaries: number;
    timelineSuggestionsPending: number;
    relationshipSuggestions: number;
  };
  reviewQueue: { total: number; conflictsUnreviewed: number };
  recentJobs: Array<{
    jobId: string;
    jobType: string;
    status: string;
    documentRef: string | null;
    caseRef: string;
    createdAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  }>;
}

interface ConfigData {
  config: {
    aiEnabled: boolean;
    localOnly: boolean;
    llmProvider: string;
    ocrProvider: string;
    embeddingProvider: string;
    maxContextChars: number;
    maxConcurrentJobs: number;
    autoProcessOnCommit: boolean;
    classificationConfidenceThreshold: number;
    qaRetrievalThreshold: number;
  };
  transparency: { processingMode: string; activeLLM: string; externalProviderNote: string };
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={`text-2xl font-semibold ${tone || ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function AIDashboardView({ role, onOpenReviewQueue, onOpenJobCase }: { role: string; onOpenReviewQueue: () => void; onOpenJobCase: (caseRef: string) => void }) {
  const [dash, setDash] = React.useState<DashboardData | null>(null);
  const [config, setConfig] = React.useState<ConfigData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const canConfigure = role === "SYSTEM_ADMIN";

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const [d, c] = await Promise.all([api.get<DashboardData>("/api/v1/ai/dashboard"), api.get<ConfigData>("/api/v1/ai/config")]);
      setDash(d);
      setConfig(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI dashboard.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function patchConfig(patch: Partial<ConfigData["config"]>) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/ai/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || "Configuration change failed.");
      setConfig((prev) => (prev ? { ...prev, config: body.data.config } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Configuration change failed.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !dash) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-rose-700">
          <CircleAlert size={18} aria-hidden /> {error}
        </CardContent>
      </Card>
    );
  }

  if (!dash || !config) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="ai-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Bot size={22} aria-hidden /> AI Document Intelligence
          </h1>
          <p className="text-sm text-muted-foreground">
            Assistive intelligence over case documents. AI is never the authoritative legal decision-maker.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCcw size={16} aria-hidden /> Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Queued jobs" value={dash.processing.queued} />
        <Stat label="Processing now" value={dash.processing.processingNow} />
        <Stat label="Completed" value={dash.processing.completed} />
        <Stat label="Partial" value={dash.processing.partial} tone={dash.processing.partial ? "text-amber-700" : ""} />
        <Stat label="Failed" value={dash.processing.failed} tone={dash.processing.failed ? "text-rose-700" : ""} />
        <Stat label="Documents processed" value={dash.processing.documentsProcessed} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSearch size={18} aria-hidden /> Intelligence artifacts
          </CardTitle>
          <CardDescription>Counts are scoped to the cases you are authorized to see.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="OCR results" value={dash.intelligence.ocrResults} />
          <Stat label="Classifications pending" value={dash.intelligence.classificationSuggestionsPending} />
          <Stat label="Entities pending" value={dash.intelligence.entitiesPendingReview} />
          <Stat label="Summaries" value={dash.intelligence.summaries} />
          <Stat label="Timeline suggestions" value={dash.intelligence.timelineSuggestionsPending} />
          <Stat label="Relationship suggestions" value={dash.intelligence.relationshipSuggestions} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4">
        <div>
          <div className="font-medium">Review queue</div>
          <div className="text-sm text-muted-foreground">
            {dash.reviewQueue.total} item(s) awaiting human verification, including {dash.reviewQueue.conflictsUnreviewed} timeline conflict(s).
          </div>
        </div>
        <Button onClick={onOpenReviewQueue}>Open Review Queue</Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {dash.recentJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI jobs yet. Start processing from a document&apos;s AI Intelligence panel.</p>
          ) : (
            <ul className="divide-y text-sm">
              {dash.recentJobs.map((j) => (
                <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">{j.jobId}</Badge>
                    <span>{j.jobType}</span>
                    <AIBadge kind={j.status === "COMPLETED" ? "AI_GENERATED" : j.status === "PENDING_REVIEW" ? "PENDING_REVIEW" : j.status === "FAILED" || j.status === "PARTIAL" ? "OVERRIDDEN" : "PENDING_REVIEW"} />
                    <span className="text-xs text-muted-foreground">
                      {j.documentRef || "case-level"} · {j.caseRef}
                    </span>
                    {j.errorMessage && <span className="text-xs text-rose-700">{j.errorMessage}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{new Date(j.createdAt).toLocaleString()}</span>
                    <Button size="sm" variant="ghost" onClick={() => onOpenJobCase(j.caseRef)}>
                      Open case
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 size={18} aria-hidden /> Processing transparency
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Processing mode:</span>
            <Badge variant="outline" className={config.transparency.processingMode === "LOCAL_ONLY" ? "bg-emerald-100 text-emerald-900 border-emerald-300" : "bg-orange-100 text-orange-900 border-orange-300"}>
              {config.transparency.processingMode}
            </Badge>
            <span className="text-muted-foreground">Active LLM:</span>
            <ModelChip provider={config.config.llmProvider} modelName={config.transparency.activeLLM} />
          </div>
          <p className="text-xs text-muted-foreground">{config.transparency.externalProviderNote}</p>
        </CardContent>
      </Card>

      {canConfigure && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">AI configuration (administrator)</CardTitle>
            <CardDescription>Changes require authorization and create an AI_CONFIG_CHANGED audit event.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="ai-enabled">AI enabled</Label>
                <p className="text-xs text-muted-foreground">Master switch for all AI services.</p>
              </div>
              <Switch id="ai-enabled" checked={config.config.aiEnabled} disabled={saving} onCheckedChange={(v) => void patchConfig({ aiEnabled: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="ai-local-only">LOCAL_ONLY mode</Label>
                <p className="text-xs text-muted-foreground">No case/document content may be sent to external providers.</p>
              </div>
              <Switch id="ai-local-only" checked={config.config.localOnly} disabled={saving} onCheckedChange={(v) => void patchConfig({ localOnly: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="ai-auto-process">Auto-process on commit</Label>
                <p className="text-xs text-muted-foreground">Enqueue AI analysis when a document is committed.</p>
              </div>
              <Switch id="ai-auto-process" checked={config.config.autoProcessOnCommit} disabled={saving} onCheckedChange={(v) => void patchConfig({ autoProcessOnCommit: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="ai-llm">LLM provider</Label>
                <p className="text-xs text-muted-foreground">heuristic = local deterministic baseline; zai = external (blocked while LOCAL_ONLY).</p>
              </div>
              <select
                id="ai-llm"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={config.config.llmProvider}
                disabled={saving || config.config.localOnly}
                onChange={(e) => void patchConfig({ llmProvider: e.target.value })}
              >
                <option value="heuristic">heuristic (local)</option>
                <option value="zai">zai (external)</option>
              </select>
            </div>
          </CardContent>
        </Card>
      )}

      <AIDisclaimer />
    </div>
  );
}
