"use client";

import * as React from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/platform/common";
import { FileCheck2, FileJson, Loader2 } from "lucide-react";

// ============================================================
// Reports (spec §41/§42/§43/§65/§66):
//  - Chain-of-Custody (per evidence)
//  - Integrity (documents + evidence of a case)
//  - Compliance-support (case history, custody, audit summary —
//    auditors/administrators; explicit disclaimer, no admissibility
//    or legal-compliance claims)
// Each generation is a NEW report instance with its own report id,
// timestamp, generator and integrity hash; generation is audited.
// Reports render as structured output with a JSON export (PDF export
// belongs to a production reporting pipeline, spec §41).
// ============================================================

type ReportBody = Record<string, unknown> & { reportId: string; reportType: string; generatedAt: string; integrityHash: string };

export function ReportsView() {
  const [caseId, setCaseId] = React.useState("");
  const [evidenceId, setEvidenceId] = React.useState("");
  const [report, setReport] = React.useState<ReportBody | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function generate(kind: "chain-of-custody" | "integrity" | "compliance") {
    setError(null);
    setReport(null);
    if (!caseId.trim()) {
      setError("Enter the case ID first (e.g. CASE-MP-IND-2026-000001).");
      return;
    }
    if (kind === "chain-of-custody" && !evidenceId.trim()) {
      setError("Chain-of-custody reports need an evidence ID (e.g. EVD-MP-IND-2026-000001).");
      return;
    }
    setBusy(kind);
    try {
      const params = new URLSearchParams({ caseId: caseId.trim() });
      if (kind === "chain-of-custody") params.set("evidenceId", evidenceId.trim());
      const res = await api.get<{ report: ReportBody }>(`/api/v1/reports/${kind}?${params.toString()}`);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Report generation failed.");
    } finally {
      setBusy(null);
    }
  }

  function downloadJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${report.reportId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Technical compliance-support reports derived from system records. They do not certify court admissibility
          and do not guarantee legal compliance. Every generation is a new, audited report instance.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="rp-case">Case ID</Label>
            <Input id="rp-case" className="font-mono text-xs" placeholder="CASE-MP-IND-2026-000001" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-evd">Evidence ID (chain-of-custody only)</Label>
            <Input id="rp-evd" className="font-mono text-xs" placeholder="EVD-MP-IND-2026-000001" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => generate("chain-of-custody")} disabled={!!busy}>
              {busy === "chain-of-custody" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileCheck2 size={14} aria-hidden />} Chain of custody
            </Button>
            <Button size="sm" variant="outline" onClick={() => generate("integrity")} disabled={!!busy}>
              {busy === "integrity" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileCheck2 size={14} aria-hidden />} Integrity
            </Button>
            <Button size="sm" variant="outline" onClick={() => generate("compliance")} disabled={!!busy}>
              {busy === "compliance" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileCheck2 size={14} aria-hidden />} Compliance
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && <ErrorState message={error} />}

      {report && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {report.reportType.replaceAll("_", " ")} report
                  <Badge variant="outline" className="font-mono text-[11px]">{report.reportId}</Badge>
                </CardTitle>
                <CardDescription>
                  Generated {new Date(report.generatedAt).toLocaleString()} · integrity hash{" "}
                  <code className="font-mono text-[11px]">{report.integrityHash.slice(0, 24)}…</code>
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={downloadJson}>
                <FileJson size={14} aria-hidden /> Export JSON
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
              {JSON.stringify(report, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
