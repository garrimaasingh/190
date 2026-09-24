"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client/api";
import { AIBadge, ConfidenceDisplay, ModelChip, reviewStatusBadge, SourceLink, AIDisclaimer } from "../ai-common";
import { CircleAlert, CheckCheck, X, ArrowUpCircle } from "lucide-react";

// ============================================================
// AIReviewQueueView — /ai/review (spec §45).
// Filters (case/type/confidence/model/status) + reviewer actions
// (Accept=VERIFIED / Reject=REJECTED / Override=OVERRIDDEN) with an
// optional comment. Reviewer identity comes from the session —
// the client never supplies a reviewer id. Source provenance is
// openable for every item where available.
// ============================================================

interface QueueItem {
  reviewKey: string;
  resultType: string;
  resultId: string;
  caseRef: string;
  documentRef: string | null;
  summary: string;
  confidence: number | null;
  model: { provider: string; modelName: string; modelVersion: string | null };
  reviewStatus: string;
  createdAt: string;
}

const RESULT_TYPES = ["", "CLASSIFICATION", "ENTITY", "SUMMARY", "TIMELINE", "RELATIONSHIP", "ENTITY_MATCH", "TIMELINE_CONFLICT"];

export function AIReviewQueueView({ onOpenSource }: { onOpenSource: (caseRef: string, documentRef: string) => void }) {
  const [items, setItems] = React.useState<QueueItem[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [resultType, setResultType] = React.useState("");
  const [caseRef, setCaseRef] = React.useState("");
  const [model, setModel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (resultType) params.set("resultType", resultType);
      if (caseRef.trim()) params.set("caseRef", caseRef.trim());
      if (model.trim()) params.set("model", model.trim());
      const data = await api.get<{ items: QueueItem[]; total: number }>(`/api/v1/ai/review-queue?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the review queue.");
    }
  }, [resultType, caseRef, model]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function review(item: QueueItem, action: "VERIFIED" | "REJECTED" | "OVERRIDDEN") {
    setBusyId(item.resultId);
    setActionError(null);
    try {
      await api.post(`/api/v1/ai/results/${encodeURIComponent(item.resultId)}/review`, {
        resultType: item.resultType,
        action,
        comment: comment.trim() || undefined,
      });
      setComment("");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Review action failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="ai-review-queue">
      <div>
        <h1 className="text-xl font-semibold">AI Review Queue</h1>
        <p className="text-sm text-muted-foreground">
          Human verification of AI results. Accept, reject or override suggestions — every action is audited with your session identity.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="rq-type">Result type</label>
            <select id="rq-type" className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={resultType} onChange={(e) => setResultType(e.target.value)}>
              {RESULT_TYPES.map((t) => (
                <option key={t || "all"} value={t}>{t || "All types"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="rq-case">Case (CASE-…)</label>
            <Input id="rq-case" className="mt-1" placeholder="e.g. CASE-MP-IND-2026-000001" value={caseRef} onChange={(e) => setCaseRef(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="rq-model">Model contains</label>
            <Input id="rq-model" className="mt-1" placeholder="e.g. heuristic" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-rose-700">
            <CircleAlert size={16} aria-hidden /> {error}
          </CardContent>
        </Card>
      )}
      {actionError && (
        <Card className="border-rose-300">
          <CardContent className="flex items-center gap-2 p-3 text-sm text-rose-700">
            <CircleAlert size={16} aria-hidden /> {actionError}
          </CardContent>
        </Card>
      )}

      {!items ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">The review queue is empty for these filters. AI suggestions appear here as they are produced.</CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{total} item(s) awaiting review (showing {items.length}).</p>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={`${item.resultType}-${item.resultId}`} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{item.resultType.replaceAll("_", " ")}</Badge>
                      <AIBadge kind={reviewStatusBadge(item.reviewStatus)} />
                      <ConfidenceDisplay confidence={item.confidence} />
                      <ModelChip provider={item.model.provider} modelName={item.model.modelName} modelVersion={item.model.modelVersion} />
                    </div>
                    <p className="text-sm">{item.summary}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="font-mono">{item.caseRef}</span>
                      {item.documentRef && (
                        <SourceLink caseRef={item.caseRef} documentRef={item.documentRef} label={`Open source: ${item.documentRef}`} onOpen={onOpenSource} />
                      )}
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-800 hover:bg-emerald-50" disabled={busyId === item.resultId} onClick={() => void review(item, "VERIFIED")}>
                      <CheckCheck size={14} aria-hidden /> Accept
                    </Button>
                    <Button size="sm" variant="outline" className="border-rose-300 text-rose-800 hover:bg-rose-50" disabled={busyId === item.resultId} onClick={() => void review(item, "REJECTED")}>
                      <X size={14} aria-hidden /> Reject
                    </Button>
                    <Button size="sm" variant="outline" className="border-orange-300 text-orange-800 hover:bg-orange-50" disabled={busyId === item.resultId} onClick={() => void review(item, "OVERRIDDEN")}>
                      <ArrowUpCircle size={14} aria-hidden /> Override
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <Textarea placeholder="Optional comment applied to your next review action (recorded in the audit trail)…" value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-[60px]" />
          </div>
          <AIDisclaimer />
        </>
      )}
    </div>
  );
}
