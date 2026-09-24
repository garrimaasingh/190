"use client";

import * as React from "react";
import {
  api,
  ApiClientError,
  type AuditIntegrityStatus,
  type ChainVerificationResponse,
  type LedgerAnchorRow,
} from "@/lib/client/api";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState, LoadingState } from "@/components/platform/common";
import { AlertTriangle, CheckCircle2, ShieldEllipsis, ShieldCheck, Anchor } from "lucide-react";

// ============================================================
// Audit Integrity dashboard (spec §61): chain status, verification
// (runs the full recompute from genesis), anchors. An integrity
// failure is NEVER hidden — the first broken event is shown with
// expected vs actual hash.
// ============================================================

export function AuditIntegrityView() {
  const { me } = useAuth();
  const [status, setStatus] = React.useState<AuditIntegrityStatus | null>(null);
  const [anchors, setAnchors] = React.useState<LedgerAnchorRow[]>([]);
  const [verification, setVerification] = React.useState<ChainVerificationResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const s = await api.get<AuditIntegrityStatus>("/api/v1/audit/integrity");
      setStatus(s);
      const a = await api.get<{ anchors: LedgerAnchorRow[] }>("/api/v1/ledger/anchors");
      setAnchors(a.anchors);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load chain status.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function runVerify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ChainVerificationResponse>("/api/v1/audit/integrity");
      setVerification(res);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Verification failed to run.");
    } finally {
      setBusy(false);
    }
  }

  async function anchorNow() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/ledger/anchors");
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Anchoring failed.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyAnchor(anchorId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ valid: boolean; detail: string | null }>(`/api/v1/ledger/anchors/${anchorId}/verify`);
      setVerification((v) => v);
      setError(res.valid ? null : `Anchor ${anchorId}: ${res.detail ?? "verification failed."}`);
      if (res.valid) await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Anchor verification failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !status) {
    return <ErrorState message={error} />;
  }
  if (!status) return <LoadingState rows={4} />;

  const lastVerificationInvalid = status.lastVerification?.result === "INVALID";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit Integrity</h1>
        <p className="text-sm text-muted-foreground">
          The audit ledger is an append-only hash chain: each event commits to the previous event&apos;s hash. Any
          modification of a historical record breaks the chain at a detectable position.
        </p>
      </div>

      {error && <p className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {status.lastVerification?.result === "INVALID" || lastVerificationInvalid ? (
                <><AlertTriangle size={18} className="text-red-600" aria-hidden /> INTEGRITY VERIFICATION FAILED</>
              ) : (
                <><CheckCircle2 size={18} className="text-emerald-600" aria-hidden /> Audit Chain Status: {status.lastVerification?.result ?? "NOT YET VERIFIED"}</>
              )}
            </CardTitle>
            <CardDescription>
              {status.lastVerification
                ? `Last verified ${new Date(status.lastVerification.verifiedAt).toLocaleString()} · through sequence ${status.lastVerification.verifiedThroughSequence ?? "—"}`
                : "Run a verification to check the full chain from genesis."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[9rem_1fr]">
              <dt className="text-muted-foreground">Events</dt><dd>{status.chain.eventCount}</dd>
              <dt className="text-muted-foreground">Last sequence</dt><dd>{status.chain.lastSequence}</dd>
              <dt className="text-muted-foreground">Hash algorithm</dt><dd>{status.chain.hashAlgorithm}</dd>
              <dt className="text-muted-foreground">Genesis hash</dt>
              <dd><code className="break-all font-mono text-xs">{status.chain.genesisHash}</code></dd>
              <dt className="text-muted-foreground">Last event hash</dt>
              <dd><code className="break-all font-mono text-xs">{status.chain.lastEventHash}</code></dd>
            </dl>
            {status.lastVerification?.firstInvalidSequence && (
              <p className="rounded-md border border-red-300 bg-red-50 p-2 text-red-900">
                First affected event: sequence {status.lastVerification.firstInvalidSequence} — do not ignore this.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={runVerify} disabled={busy}>
                <ShieldCheck size={14} aria-hidden /> Verify full chain
              </Button>
              {me?.officer.role === "SYSTEM_ADMIN" && (
                <Button size="sm" variant="outline" onClick={anchorNow} disabled={busy}>
                  <Anchor size={14} aria-hidden /> Anchor chain head
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><ShieldEllipsis size={18} aria-hidden /> Last verification result</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {!verification ? (
              <p className="text-muted-foreground">No verification has been run in this session. The cached result above is from the most recent verification by any authorized user.</p>
            ) : verification.valid ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 font-medium text-emerald-700"><CheckCircle2 size={16} aria-hidden /> VALID</p>
                <p className="text-muted-foreground">
                  {verification.eventsChecked} events recomputed (sequences {verification.fromSequence}–{verification.toSequence});
                  canonical hashes match the chain from genesis to head.
                </p>
                <code className="break-all font-mono text-xs text-muted-foreground">head: {verification.headHash}</code>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="flex items-center gap-2 font-medium text-red-700"><AlertTriangle size={16} aria-hidden /> INVALID</p>
                <p>
                  First broken event: <span className="font-mono">{verification.firstInvalid?.eventId}</span> at sequence{" "}
                  <span className="font-mono">{verification.firstInvalid?.sequence}</span> ({verification.firstInvalid?.reason}).
                </p>
                {verification.firstInvalid?.expectedHash && (
                  <p className="text-xs text-muted-foreground">expected: <code>{verification.firstInvalid.expectedHash}</code></p>
                )}
                {verification.firstInvalid?.actualHash && (
                  <p className="text-xs text-muted-foreground">actual: <code>{verification.firstInvalid.actualHash}</code></p>
                )}
              </div>
            )}
            <p className="pt-2 text-xs text-muted-foreground">
              Honest scope: the chain makes tampering evident against application and direct-database modification. It
              cannot stop an infrastructure administrator who rewrites every hash — external ledger anchoring narrows
              that window (production extension).
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ledger anchors</CardTitle>
          <CardDescription>
            Periodic commitments of the chain head (MVP adapter: DATABASE — self-verifying). Only hashes are anchored,
            never document or evidence content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {anchors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No anchors yet — anchor the chain head to create the first commitment.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Anchor</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Up to sequence</TableHead>
                    <TableHead className="hidden md:table-cell">Chain hash</TableHead>
                    <TableHead>Anchored</TableHead>
                    <TableHead className="text-right">Verify</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {anchors.map((a) => (
                    <TableRow key={a.anchorId}>
                      <TableCell className="font-mono text-xs">{a.anchorId}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[11px]">{a.provider}</Badge>
                      </TableCell>
                      <TableCell>{a.upToSequence}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground">{a.chainHash.slice(0, 18)}…</TableCell>
                      <TableCell className="text-xs">{new Date(a.anchoredAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => verifyAnchor(a.anchorId)}>Verify</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
