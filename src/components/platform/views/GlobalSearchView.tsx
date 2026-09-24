"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { SourceLink, AIDisclaimer } from "../ai-common";
import { Search, CircleAlert } from "lucide-react";

// ============================================================
// GlobalSearchView — /search (spec §46).
// Modes: keyword | semantic | hybrid. Results show document, page,
// relevant passage, match type, relevance and an "Open Source"
// link. Inaccessible documents are NEVER returned by the backend —
// this view only renders what the authorized API produced.
// ============================================================

interface SearchHit {
  documentRef: string;
  documentTitle: string;
  caseRef: string;
  caseTitle: string;
  pageNumber: number;
  relevantText: string;
  relevance: number;
  matchType: string;
  classification: string;
}

export function GlobalSearchView({ onOpenSource }: { onOpenSource: (caseRef: string, documentRef: string) => void }) {
  const [query, setQuery] = React.useState("");
  const [mode, setMode] = React.useState<"keyword" | "semantic" | "hybrid">("hybrid");
  const [results, setResults] = React.useState<SearchHit[] | null>(null);
  const [searched, setSearched] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    if (query.trim().length < 2) {
      setError("Enter at least 2 characters to search.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const data = await api.post<{ results: SearchHit[] }>("/api/v1/search/hybrid", { query: query.trim(), mode, limit: 15 });
      setResults(data.results);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="global-search">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Search size={20} aria-hidden /> Case Content Search
        </h1>
        <p className="text-sm text-muted-foreground">
          Search inside authorized case documents. Semantic mode finds related content even when the exact words differ. Authorization is enforced server-side.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder='e.g. "documents mentioning seizure of a mobile phone"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              aria-label="Search query"
            />
            <Button onClick={() => void run()} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Search mode">
            {(["keyword", "semantic", "hybrid"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  mode === m ? "border-slate-900 bg-slate-900 text-white" : "bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-rose-700">
              <CircleAlert size={14} aria-hidden /> {error}
            </p>
          )}
        </CardContent>
      </Card>

      {loading && <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20" />)}</div>}

      {results && !loading && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{results.length} result(s)</CardTitle>
            <CardDescription>Only content from cases and classifications you are authorized to see is included.</CardDescription>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {searched ? "No matching authorized content was found." : "Enter a query to search."}
              </p>
            ) : (
              <ul className="divide-y">
                {results.map((r, i) => (
                  <li key={`${r.documentRef}-${r.pageNumber}-${i}`} className="space-y-1.5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SourceLink caseRef={r.caseRef} documentRef={r.documentRef} page={r.pageNumber} label={`${r.documentRef} — page ${r.pageNumber}`} onOpen={onOpenSource} />
                      <Badge variant="outline" className="text-[10px] capitalize">{r.matchType} match</Badge>
                      <Badge variant="secondary" className="text-[10px]">{r.classification}</Badge>
                      <span className="text-xs text-muted-foreground">Relevance: {(r.relevance * 100).toFixed(0)}%</span>
                    </div>
                    <p className="text-sm">
                      <span className="font-medium">{r.documentTitle}</span>
                      <span className="text-muted-foreground"> · {r.caseTitle} ({r.caseRef})</span>
                    </p>
                    <p className="rounded-md bg-muted p-2 text-xs leading-relaxed text-muted-foreground">{r.relevantText}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <AIDisclaimer>
        Semantic similarity does not establish identity or legal relevance. Search covers only authorized documents; results are ranked by model relevance, not legal weight.
      </AIDisclaimer>
    </div>
  );
}
