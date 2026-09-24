"use client";

import * as React from "react";
import {
  api,
  ApiClientError,
  type Meta,
  type DocumentUploadResponse,
  type RelatedDocumentResponse,
  type DocumentDetailResponse,
  type DocumentRow,
} from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { FieldError } from "@/components/platform/common";
import { ClassificationBadge, formatBytes } from "@/components/platform/DocumentsSection";
import {
  ArrowLeft,
  ArrowRight,
  FileUp,
  Lock,
  ShieldCheck,
  Fingerprint,
  Database,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Info,
} from "lucide-react";

// ============================================================
// Upload Document wizard (spec §59/§60/§61):
//   1 Select File → 2 Document Information → 3 Security
//   Classification → 4 Review → 5 Secure Commit.
// One multipart POST runs the real server pipeline (validate →
// scan → hash → encrypt → store → commit); the stage list shows
// the server-side processing states while the request is in
// flight. The result screen reflects the authoritative response.
// Also serves the Supplement/Correction/Replacement workflows by
// pre-linking a target document (spec §37/§38/§39).
// ============================================================

export type RelatedWorkflow = "SUPPLEMENT" | "CORRECTION" | "REPLACEMENT" | null;

const COMMIT_STAGES = [
  { key: "validating", label: "Validating file…", icon: ShieldCheck },
  { key: "hashing", label: "Calculating integrity fingerprint…", icon: Fingerprint },
  { key: "encrypting", label: "Encrypting (AES-256-GCM)…", icon: Lock },
  { key: "storing", label: "Securing document in storage…", icon: Database },
  { key: "committing", label: "Committing immutable record…", icon: CheckCircle2 },
];

export function DocumentUploadView({
  caseRef,
  meta,
  workflow,
  targetDocumentId,
  onCommitted,
  onBack,
}: {
  caseRef: string;
  meta: Meta | null;
  workflow: RelatedWorkflow;
  targetDocumentId: string | null;
  onCommitted: (documentId: string, mode?: "details" | "view") => void;
  onBack: () => void;
}) {
  const [step, setStep] = React.useState(1);
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [documentType, setDocumentType] = React.useState("");
  const [documentCategory, setDocumentCategory] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [documentDate, setDocumentDate] = React.useState("");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [issuingDepartmentName, setIssuingDepartmentName] = React.useState("");
  const [externalReference, setExternalReference] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [classification, setClassification] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [committing, setCommitting] = React.useState(false);
  const [stageIndex, setStageIndex] = React.useState(-1);
  const [result, setResult] = React.useState<{ document: DocumentRow; quarantined: boolean; duplicateWarning: string | null; supersededTarget?: boolean } | null>(null);

  const maxMb = meta?.documents.maxSizeMb ?? 25;
  const allowedExt = meta?.documents.allowedExtensions ?? ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "txt", "csv"];

  // Resolve the related-workflow target (banner + title/type prefill)
  const [targetDocument, setTargetDocument] = React.useState<DocumentRow | null>(null);
  React.useEffect(() => {
    if (!workflow || !targetDocumentId) {
      setTargetDocument(null);
      return;
    }
    api
      .get<DocumentDetailResponse>(
        `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(targetDocumentId)}`
      )
      .then((d) => setTargetDocument(d.document))
      .catch(() => setTargetDocument(null));
  }, [workflow, targetDocumentId, caseRef]);

  // Prefill for related-document workflows
  React.useEffect(() => {
    if (workflow && targetDocument) {
      const suffix = workflow.charAt(0) + workflow.slice(1).toLowerCase();
      setTitle(`${targetDocument.title} — ${suffix}`.slice(0, 200));
      setDocumentType(targetDocument.documentType);
    }
  }, [workflow, targetDocument]);

  function onFileChange(f: File | null) {
    setFile(f);
    setError(null);
    if (!f) return;
    const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
    if (!allowedExt.includes(ext)) {
      setError(`Unsupported file type ".${ext}". Allowed: ${allowedExt.join(", ").toUpperCase()}.`);
      setFile(null);
      return;
    }
    if (f.size > maxMb * 1024 * 1024) {
      setError(`File exceeds the ${maxMb} MB limit.`);
      setFile(null);
    }
  }

  function validateStep(target: number): string | null {
    if (target >= 2) {
      if (!file) return "Please select a file first.";
    }
    if (target >= 3) {
      if (title.trim().length < 2) return "Document title is required (min 2 characters).";
      if (!documentType) return "Document type is required.";
    }
    if (target >= 4) {
      if (!classification) return "Select a security classification.";
    }
    return null;
  }

  function goNext() {
    const problem = validateStep(step + 1);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((s) => Math.min(4, s + 1));
  }

  async function commit() {
    if (!file) return;
    setError(null);
    setCommitting(true);
    setStageIndex(0);
    // Progress the visible stage list while the single server request runs.
    const ticker = setInterval(() => setStageIndex((i) => Math.min(i + 1, COMMIT_STAGES.length - 1)), 550);

    const clientRequestId = crypto.randomUUID();
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      form.append("documentType", documentType);
      form.append("classification", classification);
      if (documentCategory) form.append("documentCategory", documentCategory);
      if (description.trim()) form.append("description", description.trim());
      if (documentDate) form.append("documentDate", new Date(documentDate).toISOString());
      if (referenceNumber.trim()) form.append("referenceNumber", referenceNumber.trim());
      if (issuingDepartmentName.trim()) form.append("issuingDepartmentName", issuingDepartmentName.trim());
      if (externalReference.trim()) form.append("externalReference", externalReference.trim());
      if (tags.trim()) form.append("tags", tags.trim());
      form.append("clientRequestId", clientRequestId);

      const endpoint = workflow && targetDocument
        ? `/api/v1/cases/${encodeURIComponent(caseRef)}/documents/${encodeURIComponent(targetDocument.id)}/${workflow.toLowerCase()}`
        : `/api/v1/cases/${encodeURIComponent(caseRef)}/documents`;

      const res = workflow && targetDocument
        ? await api.upload<RelatedDocumentResponse>(endpoint, form)
        : await api.upload<DocumentUploadResponse>(endpoint, form);

      clearInterval(ticker);
      setStageIndex(COMMIT_STAGES.length - 1);
      const doc = "document" in res ? res.document : (res as RelatedDocumentResponse).document;
      setResult({
        document: doc,
        quarantined: res.quarantined,
        duplicateWarning: res.duplicateWarning,
        supersededTarget: "supersededTarget" in res ? res.supersededTarget : undefined,
      });
    } catch (err) {
      clearInterval(ticker);
      setCommitting(false);
      setStageIndex(-1);
      setError(
        err instanceof ApiClientError
          ? err.message
          : "The document could not be committed. No record was created."
      );
      return;
    }
    setCommitting(false);
  }

  // ---------- result screens ----------
  if (result) {
    const doc = result.document;
    return (
      <div className="space-y-4" data-testid="upload-result">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {result.quarantined ? (
                <><AlertTriangle aria-hidden size={18} className="text-orange-600" /> Document quarantined</>
              ) : (
                <><CheckCircle2 aria-hidden size={18} className="text-emerald-600" /> Document successfully committed</>
              )}
            </CardTitle>
            <CardDescription>
              {result.quarantined
                ? "The file was flagged by the security scan and quarantined. It was NOT committed as a valid document."
                : workflow === "REPLACEMENT"
                  ? "The replacement document is committed; the original is now SUPERSEDED and remains stored."
                  : workflow
                    ? `The ${workflow.toLowerCase()} was committed as a new immutable document.`
                    : "The document is now an immutable record in the case."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Document ID</dt><dd className="font-mono">{doc.id}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Case ID</dt><dd className="font-mono">{doc.caseId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Document Type</dt><dd>{doc.documentType.replaceAll("_", " ")}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Classification</dt><dd><ClassificationBadge classification={doc.classification} /></dd></div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">SHA-256 integrity fingerprint</dt>
                <dd className="break-all font-mono text-xs">{doc.sha256Hash}</dd>
              </div>
              <div><dt className="text-xs text-muted-foreground">Committed At</dt><dd>{doc.committedAt ? new Date(doc.committedAt).toLocaleString() : "—"}</dd></div>
              {result.duplicateWarning && (
                <div className="sm:col-span-2">
                  <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Note: this file appears identical to an existing document ({result.duplicateWarning}). Both records are preserved.
                  </p>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button className="gap-2" onClick={() => onCommitted(doc.id, "view")}><Eye size={15} aria-hidden /> View Document</Button>
          <Button variant="outline" className="gap-2" onClick={() => onCommitted(doc.id, "details")}><Info size={15} aria-hidden /> View Details</Button>
          <Button variant="ghost" onClick={onBack}>Return to Case</Button>
        </div>
      </div>
    );
  }

  // ---------- wizard ----------
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Upload steps">
        {["Select File", "Document Information", "Security Classification", "Review"].map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <Badge variant={step === i + 1 ? "default" : step > i + 1 ? "secondary" : "outline"}>
              {step > i + 1 ? "✓" : i + 1}
            </Badge>
            <span className={step === i + 1 ? "font-medium" : "text-muted-foreground"}>{label}</span>
            {i < 3 && <span aria-hidden className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>

      {workflow && targetDocument && (
        <p className="rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-sm text-teal-900">
          Creating a <strong>{workflow.toLowerCase()}</strong> of <strong>{targetDocument.title}</strong> ({targetDocument.id}).
          The original remains unchanged.
        </p>
      )}

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1 — Select File</CardTitle>
            <CardDescription>
              Allowed formats: {allowedExt.join(", ").toUpperCase()} · max {maxMb} MB. The file type is verified on the
              server from the actual content (magic bytes), not the browser declaration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="file"
              accept={allowedExt.map((e) => `.${e}`).join(",")}
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
              aria-label="Document file"
            />
            {file && (
              <div className="rounded-md border px-3 py-2 text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)} · declared as {file.type || "unknown (server will detect)"}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 2 — Document Information</CardTitle>
            <CardDescription>Metadata is preserved with the immutable record. The document date is the business date — distinct from upload time.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="doc-title">Document Title *</Label>
              <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </div>
            <div>
              <Label>Document Type *</Label>
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger aria-label="Document type"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {(meta?.documentTypes || []).map((t) => (
                    <SelectItem key={t} value={t}>{t.replaceAll("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Select value={documentCategory} onValueChange={setDocumentCategory}>
                <SelectTrigger aria-label="Document category"><SelectValue placeholder="Optional category" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">—</SelectItem>
                  {(meta?.documentCategories || []).map((c) => (
                    <SelectItem key={c} value={c}>{c.replaceAll("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="doc-description">Description</Label>
              <Textarea id="doc-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <div>
              <Label htmlFor="doc-date">Document Date</Label>
              <Input id="doc-date" type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="doc-ref">Reference Number</Label>
              <Input id="doc-ref" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} maxLength={100} placeholder="e.g. FIR/124/2026" />
            </div>
            <div>
              <Label htmlFor="doc-issuing">Issuing Department</Label>
              <Input id="doc-issuing" value={issuingDepartmentName} onChange={(e) => setIssuingDepartmentName(e.target.value)} maxLength={160} />
            </div>
            <div>
              <Label htmlFor="doc-extref">External Reference</Label>
              <Input id="doc-extref" value={externalReference} onChange={(e) => setExternalReference(e.target.value)} maxLength={100} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="doc-tags">Tags (comma-separated)</Label>
              <Input id="doc-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="forensics, phase-1" />
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3 — Security Classification</CardTitle>
            <CardDescription>Classification is independent of document type and controls who can see this document.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={classification} onValueChange={setClassification} className="gap-3">
              {(meta?.documentClassifications || ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"]).map((c) => (
                <Label
                  key={c}
                  htmlFor={`cls-${c}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${classification === c ? "border-primary bg-accent/40" : ""}`}
                >
                  <RadioGroupItem id={`cls-${c}`} value={c} className="mt-0.5" />
                  <span>
                    <span className="block font-medium">{c.replaceAll("_", " ")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {meta?.documentClassificationNotes?.[c] || "Access is limited to authorized case participants."}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
      )}

      {step === 4 && file && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 4 — Review</CardTitle>
            <CardDescription>Confirm before secure commit. Once committed, the record is immutable — corrections are created as new documents.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">File</dt><dd>{file.name} · {formatBytes(file.size)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Case</dt><dd className="font-mono">{caseRef}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Title</dt><dd>{title}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Type</dt><dd>{documentType.replaceAll("_", " ")}{documentCategory ? ` · ${documentCategory.replaceAll("_", " ")}` : ""}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Classification</dt><dd><ClassificationBadge classification={classification} /></dd></div>
              <div><dt className="text-xs text-muted-foreground">Document Date</dt><dd>{documentDate || "—"}</dd></div>
              {referenceNumber && <div><dt className="text-xs text-muted-foreground">Reference</dt><dd>{referenceNumber}</dd></div>}
              {workflow && targetDocument && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Relationship</dt>
                  <dd>{workflow} → {targetDocument.id}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      {error && <FieldError message={error} />}

      {committing ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><FileUp aria-hidden size={16} /> Secure Commit</CardTitle>
            <CardDescription>Processing on the server — do not close this page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={((stageIndex + 1) / COMMIT_STAGES.length) * 100} aria-label="Commit progress" />
            <ul className="space-y-1.5 text-sm">
              {COMMIT_STAGES.map((stage, i) => {
                const Icon = stage.icon;
                const done = i < stageIndex;
                const active = i === stageIndex;
                return (
                  <li key={stage.key} className={`flex items-center gap-2 ${done ? "text-emerald-700" : active ? "font-medium" : "text-muted-foreground"}`}>
                    <Icon size={15} aria-hidden className={active ? "animate-pulse" : ""} />
                    {stage.label}
                    {done && <span aria-hidden>✓</span>}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : (
        !result && (
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={onBack} className="gap-2"><ArrowLeft size={15} aria-hidden /> Cancel</Button>
            <div className="flex gap-2">
              {step > 1 && (
                <Button variant="outline" onClick={() => { setError(null); setStep((s) => s - 1); }} className="gap-2">
                  <ArrowLeft size={15} aria-hidden /> Back
                </Button>
              )}
              {step < 4 && <Button onClick={goNext} className="gap-2">Next <ArrowRight size={15} aria-hidden /></Button>}
              {step === 4 && (
                <Button onClick={commit} className="gap-2"><Lock size={15} aria-hidden /> Commit Document</Button>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}
