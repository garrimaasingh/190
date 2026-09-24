"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Bot, UserCheck, CircleDashed, BookLock, ExternalLink } from "lucide-react";

// ============================================================
// Shared AI provenance/labeling components (spec §66/§31).
//
// UI RULE: AI output must never be visually presented as official
// government/legal fact. Every AI artifact carries an explicit
// badge: AUTHORITATIVE | AI SUGGESTION | AI GENERATED |
// HUMAN VERIFIED | PENDING REVIEW. Confidence is always labeled
// "Model Confidence" — it expresses model output confidence, not
// probability of truth.
// ============================================================

const AI_BADGE_STYLES: Record<string, string> = {
  AUTHORITATIVE: "bg-slate-900 text-white border-slate-900",
  AI_GENERATED: "bg-violet-100 text-violet-900 border-violet-300",
  AI_SUGGESTION: "bg-violet-100 text-violet-900 border-violet-300",
  HUMAN_VERIFIED: "bg-emerald-100 text-emerald-900 border-emerald-300",
  PENDING_REVIEW: "bg-amber-100 text-amber-900 border-amber-300",
  REJECTED: "bg-rose-100 text-rose-900 border-rose-300",
  OVERRIDDEN: "bg-orange-100 text-orange-900 border-orange-300",
};

export function AIBadge({ kind }: { kind: "AUTHORITATIVE" | "AI_GENERATED" | "AI_SUGGESTION" | "HUMAN_VERIFIED" | "PENDING_REVIEW" | "REJECTED" | "OVERRIDDEN" }) {
  const icon =
    kind === "HUMAN_VERIFIED" ? <UserCheck size={12} aria-hidden /> :
    kind === "PENDING_REVIEW" ? <CircleDashed size={12} aria-hidden /> :
    kind === "AUTHORITATIVE" ? <BookLock size={12} aria-hidden /> :
    <Bot size={12} aria-hidden />;
  return (
    <Badge variant="outline" className={`${AI_BADGE_STYLES[kind]} gap-1 font-medium`}>
      {icon}
      {kind.replaceAll("_", " ")}
    </Badge>
  );
}

/** reviewStatus → badge kind */
export function reviewStatusBadge(status: string | null | undefined): "HUMAN_VERIFIED" | "PENDING_REVIEW" | "REJECTED" | "OVERRIDDEN" {
  switch (status) {
    case "VERIFIED":
    case "ACCEPTED":
    case "CONFIRMED":
    case "RESOLVED":
      return "HUMAN_VERIFIED";
    case "REJECTED":
    case "DISMISSED":
      return "REJECTED";
    case "OVERRIDDEN":
      return "OVERRIDDEN";
    default:
      return "PENDING_REVIEW";
  }
}

/** Model Confidence (spec §31) — explicitly NOT "probability of truth". */
export function ConfidenceDisplay({ confidence, size = "sm" }: { confidence: number | null | undefined; size?: "sm" | "md" }) {
  if (confidence === null || confidence === undefined) return <span className="text-xs text-muted-foreground">No confidence reported</span>;
  const pct = Math.round(confidence * 100);
  const low = pct < 50;
  return (
    <span className={`inline-flex items-center gap-1.5 ${size === "sm" ? "text-xs" : "text-sm"}`}>
      <span className="text-muted-foreground">Model Confidence:</span>
      {low ? (
        <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300">Low Confidence ({pct}%)</Badge>
      ) : (
        <span className="font-medium">{pct}%</span>
      )}
    </span>
  );
}

export function ModelChip({ provider, modelName, modelVersion, processingMode }: { provider?: string | null; modelName?: string | null; modelVersion?: string | null; processingMode?: "LOCAL" | "EXTERNAL" }) {
  if (!provider) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <Badge variant="secondary" className="font-mono text-[10px]">
        {provider}/{modelName}{modelVersion ? `@${modelVersion}` : ""}
      </Badge>
      {processingMode && (
        <Badge variant="outline" className={`text-[10px] ${processingMode === "EXTERNAL" ? "bg-orange-100 text-orange-900 border-orange-300" : "bg-emerald-100 text-emerald-900 border-emerald-300"}`}>
          {processingMode === "EXTERNAL" ? "EXTERNAL PROCESSING" : "LOCAL PROCESSING"}
        </Badge>
      )}
    </span>
  );
}

/** "Open Source" link (spec §12/§70): navigates to the document viewer at the relevant page. */
export function SourceLink({
  caseRef,
  documentRef,
  page,
  label,
  onOpen,
}: {
  caseRef?: string;
  documentRef: string;
  page?: number | null;
  label?: string;
  onOpen?: (caseRef: string, documentRef: string) => void;
}) {
  if (!onOpen || !caseRef) {
    return <span className="text-[11px] text-muted-foreground">{label || `${documentRef}${page ? ` — page ${page}` : ""}`}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(caseRef, documentRef)}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-800 underline-offset-2 hover:underline"
      title={`Open source document ${documentRef}${page ? ` at page ${page}` : ""}`}
    >
      {label || `${documentRef}${page ? ` — page ${page}` : ""}`}
      <ExternalLink size={11} aria-hidden />
    </button>
  );
}

export function AIDisclaimer({ children }: { children?: React.ReactNode }) {
  return (
    <p className="rounded-md border border-violet-200 bg-violet-50 p-2 text-[11px] leading-relaxed text-violet-900">
      {children ||
        "AI outputs may contain errors. AI extraction is not authoritative unless human verified. AI summaries depend on available source material. Poor OCR can affect AI results. Semantic similarity does not establish identity or legal relevance. AI does not determine legal outcomes."}
    </p>
  );
}
