"use client";

import * as React from "react";
import { api, ApiClientError, type EvidenceRow, type Meta } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldError, LoadingState } from "@/components/platform/common";
import { ClassificationBadge } from "@/components/platform/DocumentsSection";
import { ArrowLeft, ArrowRight, Check, ShieldCheck, Upload } from "lucide-react";

// ============================================================
// Register Evidence — 6-section wizard (spec §38/§39):
//   1 Evidence Information · 2 Source · 3 Custody · 4 Digital
//   Content (optional) · 5 Classification (with concrete control
//   explanations, spec §54 style) · 6 Review.
// A digital file runs the secure pipeline (hash → encrypt → store →
// commit); physical evidence commits metadata + custody only.
// The server derives registrar/custodian/hashes — no identity or
// integrity field is submitted from here.
// ============================================================

const STEPS = ["Evidence Information", "Source", "Custody", "Digital Content", "Classification", "Review"] as const;

interface EvidenceRegisterViewProps {
  caseRef: string;
  meta: Meta | null;
  onRegistered: (evidenceId: string) => void;
  onBack: () => void;
}

export function EvidenceRegisterView({ caseRef, meta, onRegistered, onBack }: EvidenceRegisterViewProps) {
  const [step, setStep] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ evidence: EvidenceRow; duplicateWarning: string | null } | null>(null);

  // --- fields ---
  const [title, setTitle] = React.useState("");
  const [evidenceType, setEvidenceType] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [sourceType, setSourceType] = React.useState("");
  const [sourceReference, setSourceReference] = React.useState("");
  const [collectionLocation, setCollectionLocation] = React.useState("");
  const [collectedAt, setCollectedAt] = React.useState("");
  const [condition, setCondition] = React.useState("");
  const [collectedByOfficerId, setCollectedByOfficerId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [evidenceNumber, setEvidenceNumber] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [classification, setClassification] = React.useState("");

  const evidenceTypes = meta?.evidenceTypes ?? [];
  const sourceTypes = meta?.evidenceSourceTypes ?? [];
  const classifications = meta?.evidenceClassifications ?? [];

  const canContinue =
    (step === 0 && title.trim().length >= 2 && evidenceType) ||
    (step === 1 && sourceType) ||
    step === 2 ||
    step === 3 ||
    (step === 4 && classification) ||
    step === 5;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("title", title.trim());
      form.set("evidenceType", evidenceType);
      if (category.trim()) form.set("category", category.trim());
      if (description.trim()) form.set("description", description.trim());
      form.set("sourceType", sourceType);
      if (sourceReference.trim()) form.set("sourceReference", sourceReference.trim());
      if (collectionLocation.trim()) form.set("collectionLocation", collectionLocation.trim());
      if (collectedAt) form.set("collectedAt", new Date(collectedAt).toISOString());
      if (condition.trim()) form.set("condition", condition.trim());
      if (collectedByOfficerId.trim()) form.set("collectedByOfficerId", collectedByOfficerId.trim());
      if (notes.trim()) form.set("notes", notes.trim());
      if (evidenceNumber.trim()) form.set("evidenceNumber", evidenceNumber.trim());
      form.set("classification", classification);
      if (file) form.set("file", file);
      const res = await api.upload<{ evidence: EvidenceRow; duplicateWarning: string | null }>(
        `/api/v1/cases/${caseRef}/evidence`,
        form
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Evidence registration failed.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const ev = result.evidence;
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck size={18} className="text-emerald-600" aria-hidden /> Evidence registered
          </CardTitle>
          <CardDescription>
            The record was committed with an initial custody entry and an immutable audit event.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono">{ev.id}</Badge>
            <ClassificationBadge classification={ev.classification} />
          </div>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <dt className="text-muted-foreground">Title</dt>
            <dd className="font-medium">{ev.title}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{ev.evidenceType.replaceAll("_", " ")}</dd>
            <dt className="text-muted-foreground">Digital content</dt>
            <dd>{ev.hasDigitalContent ? `${ev.originalFilename} (${ev.mimeType})` : "None — physical evidence"}</dd>
            {ev.hasDigitalContent && (
              <>
                <dt className="text-muted-foreground">Integrity algorithm</dt>
                <dd>{ev.hashAlgorithm}</dd>
                <dt className="text-muted-foreground">Integrity fingerprint (SHA-256)</dt>
                <dd className="break-all font-mono text-xs">{ev.sha256Hash}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Committed at</dt>
            <dd>{ev.committedAt ? new Date(ev.committedAt).toLocaleString() : "—"}</dd>
          </dl>
          {result.duplicateWarning && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
              Duplicate warning: content identical to {result.duplicateWarning} already exists in this case. Registration
              proceeded — identical hashes are informational, never identifiers.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            The fingerprint is an integrity reference for verification workflows. It is not, by itself, a claim of legal admissibility.
          </p>
          <Button onClick={() => onRegistered(ev.id)}>
            Open evidence details <ArrowRight size={16} aria-hidden />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden /> Back to case
        </Button>
        <h1 className="mt-2 text-xl font-semibold">Register Evidence</h1>
        <p className="text-sm text-muted-foreground">
          Register an item under custody for this case. Every step is enforced server-side.
        </p>
      </div>

      {/* Step indicator */}
      <ol className="flex flex-wrap gap-2" aria-label="Registration steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <Badge variant={i === step ? "default" : i < step ? "secondary" : "outline"} className="font-normal">
              {i + 1}. {s}
            </Badge>
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-6">
          {step === 0 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ev-title">Title *</Label>
                <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. CCTV Recording — Market Premises" maxLength={200} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ev-type">Evidence type *</Label>
                  <Select value={evidenceType} onValueChange={setEvidenceType}>
                    <SelectTrigger id="ev-type"><SelectValue placeholder="Select type" /></SelectTrigger>
                    <SelectContent>
                      {evidenceTypes.map((t) => <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ev-category">Category</Label>
                  <Input id="ev-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Mobile handset" maxLength={80} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ev-desc">Description</Label>
                <Textarea id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder="What is this item and why is it evidence?" />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ev-source">Source type *</Label>
                  <Select value={sourceType} onValueChange={setSourceType}>
                    <SelectTrigger id="ev-source"><SelectValue placeholder="Select source" /></SelectTrigger>
                    <SelectContent>
                      {sourceTypes.map((t) => <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ev-src-ref">Source reference</Label>
                  <Input id="ev-src-ref" value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} placeholder="e.g. seizure memo number" maxLength={100} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ev-loc">Collection location</Label>
                  <Input id="ev-loc" value={collectionLocation} onChange={(e) => setCollectionLocation(e.target.value)} maxLength={200} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ev-date">Collection date & time</Label>
                  <Input id="ev-date" type="datetime-local" value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Source values are system classification labels, not exhaustive legal categories. GPS or device metadata
                is optional and not available for every evidence type.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ev-collector">Collecting officer (public ID, optional)</Label>
                  <Input id="ev-collector" value={collectedByOfficerId} onChange={(e) => setCollectedByOfficerId(e.target.value)} placeholder="OFF-MP-IND-00004" maxLength={60} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ev-evnum">External evidence number</Label>
                  <Input id="ev-evnum" value={evidenceNumber} onChange={(e) => setEvidenceNumber(e.target.value)} placeholder="e.g. SEIZ/2026/0117" maxLength={100} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ev-cond">Condition at collection</Label>
                <Input id="ev-cond" value={condition} onChange={(e) => setCondition(e.target.value)} maxLength={300} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ev-notes">Custody notes</Label>
                <Textarea id="ev-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
              </div>
              <p className="text-xs text-muted-foreground">
                Your department becomes the first custodian; your identity is derived from the session, never from this form.
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ev-file">Digital content (optional)</Label>
                <Input
                  id="ev-file"
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.csv,.mp4,.zip,.dd,.001,.e01"
                />
              </div>
              {file && (
                <p className="text-sm">
                  Selected: <span className="font-medium">{file.name}</span> ({(file.size / 1024).toFixed(1)} KB)
                </p>
              )}
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">What happens to a digital file</p>
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Extension, declared type and magic bytes are validated — the browser declaration is never trusted.</li>
                  <li>SHA-256 is computed over the plaintext before encryption.</li>
                  <li>The file is encrypted (AES-256-GCM) and stored under an opaque server-generated key.</li>
                  <li>The record, custody entry and audit events commit in one transaction — a failed upload leaves no record.</li>
                </ol>
                <p className="mt-1">Leave empty to register physical evidence (metadata and custody tracking only).</p>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              {classifications.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setClassification(c)}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${classification === c ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                  aria-pressed={classification === c}
                >
                  <div className="flex items-center justify-between">
                    <ClassificationBadge classification={c} />
                    {classification === c && <Check size={16} aria-hidden />}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {meta?.evidenceClassificationNotes?.[c] ?? ""}
                  </p>
                </button>
              ))}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3 text-sm">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <dt className="text-muted-foreground">Title</dt><dd className="font-medium">{title || "—"}</dd>
                <dt className="text-muted-foreground">Type / category</dt>
                <dd>{evidenceType ? evidenceType.replaceAll("_", " ") : "—"}{category ? ` · ${category}` : ""}</dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd>{sourceType.replaceAll("_", " ")}{sourceReference ? ` · ${sourceReference}` : ""}</dd>
                <dt className="text-muted-foreground">Collection</dt>
                <dd>{collectionLocation || "—"}{collectedAt ? ` · ${new Date(collectedAt).toLocaleString()}` : ""}</dd>
                <dt className="text-muted-foreground">Digital content</dt>
                <dd>{file ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)` : "None — physical evidence"}</dd>
                <dt className="text-muted-foreground">Classification</dt>
                <dd>{classification ? <ClassificationBadge classification={classification} /> : "—"}</dd>
              </dl>
              {error && <FieldError message={error} />}
              <p className="text-xs text-muted-foreground">
                On submit: validate → scan → hash → encrypt → store → commit (digital), or metadata + custody commit
                (physical). Custody entry and audit events are recorded with the commit itself.
              </p>
            </div>
          )}

          {error && step !== 5 && <FieldError message={error} />}

          <div className="flex justify-between border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>
              <ArrowLeft size={14} aria-hidden /> Previous
            </Button>
            {step < 5 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)} disabled={!canContinue}>
                Next <ArrowRight size={14} aria-hidden />
              </Button>
            ) : (
              <Button size="sm" onClick={submit} disabled={busy || !canContinue}>
                {busy ? <LoadingState rows={1} /> : <><Upload size={14} aria-hidden /> Register Evidence</>}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
