import { createHash } from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { AuthContext } from "@/lib/auth";
import type { CaseAccess } from "@/lib/cases/access";
import { appendAuditEvent, recordAuditEvent } from "@/lib/audit/service";
import { generateAIJobId } from "@/lib/cases/ids";
import {
  AI_JOB_TERMINAL_STATUSES,
  AI_RATE_LIMITS,
  DOCUMENT_CLASSIFICATION_LEVEL,
} from "@/lib/constants";
import { rateLimit } from "@/lib/rate-limit";
import { getAIConfig } from "./config";
import { resolveAIProvider } from "./providers/registry";
import { HeuristicAIProvider } from "./providers/heuristic";
import { LocalOnlyBlockedError } from "./providers/zai";
import { AIOutputValidationError, type SourcePage } from "./providers/types";
import { DocumentTextExtractor, TextExtractionError } from "./text-extraction";
import { OcrLanguageUnavailableError } from "./ocr";
import { chunkPages } from "./chunking";
import { getEmbeddingProvider, VectorStore, cosineSimilarity } from "./embeddings";
import { buildAuthorizedScope, type AuthorizedCaseScope } from "./authorization";

// ============================================================
// AIProcessingService + worker (spec §4/§5/§51).
//
// ASYNCHRONOUS BY DESIGN (spec §4): expensive processing never runs
// inside the upload request. Phase 3's commit pipeline enqueues an
// AI job (when auto-process is enabled); the in-process worker
// claims jobs atomically (conditional status swap — the same
// optimistic pattern the custody services use) and runs the
// pipeline outside any request.
//
// AIJobQueue abstraction: the DatabaseJobQueue below is the live
// adapter; the queue interface is the seam for Redis/Celery-style
// brokers (none claimed as implemented).
//
// PARTIAL results (spec §51): each stage records its own artifacts;
// failures are collected per stage and the job ends COMPLETED /
// PARTIAL / FAILED — successful stage outputs are never discarded.
//
// AUDIT (spec §39): every lifecycle transition and artifact creation
// appends to the Phase 4 immutable chain — references only, never
// document content.
// ============================================================

export interface EnqueueParams {
  ctx: AuthContext;
  jobType: string;
  documentId?: string | null; // internal id
  caseInternalId: string;
  caseRef: string;
  documentRef?: string | null;
  priority?: string;
  requestedProvider?: string;
}

export async function enqueueAIJob(params: EnqueueParams) {
  // Rate limit per officer for expensive operations (spec §34/§49).
  const rl = rateLimit(`ai-process:${params.ctx.officer.id}`, AI_RATE_LIMITS.PROCESS.limit, AI_RATE_LIMITS.PROCESS.windowMs);
  if (!rl.allowed) {
    throw new ApiError(429, "AI_RATE_LIMITED", `Too many AI processing requests. Retry in ${rl.retryAfterSeconds}s.`);
  }
  const config = await getAIConfig();
  if (!config.aiEnabled) {
    throw new ApiError(503, "AI_DISABLED", "AI services are currently disabled by the platform administrator.");
  }

  const jobId = await generateAIJobId();
  const job = await db.aIProcessingJob.create({
    data: {
      jobId,
      documentId: params.documentId ?? null,
      documentRef: params.documentRef ?? null,
      caseId: params.caseInternalId,
      caseRef: params.caseRef,
      requestedByOfficerId: params.ctx.officer.id,
      requestedByDepartmentId: params.ctx.officer.departmentId,
      jobType: params.jobType,
      status: "QUEUED",
      priority: params.priority || "NORMAL",
      modelProvider: params.requestedProvider || config.llmProvider,
    },
  });

  await appendAuditEvent({
    eventType: "AI_JOB_CREATED",
    actorOfficerId: params.ctx.officer.id,
    actorDepartmentId: params.ctx.officer.departmentId,
    caseId: params.caseRef,
    documentId: params.documentRef ?? null,
    sessionId: params.ctx.sessionId,
    metadata: { jobId, jobType: params.jobType, requestedProvider: params.requestedProvider || config.llmProvider },
  });

  // Fire the worker — processing happens OUTSIDE the request.
  scheduleDrain();
  return job;
}

// ------------------------------------------------------------
// Worker
// ------------------------------------------------------------

// Workers currently in-flight (reserved for the concurrent broker model).
const inFlight = new Set<string>();
let drainScheduled = false;

/** Debounced drain trigger — never blocks the caller. */
export function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(() => {
    drainScheduled = false;
    void drainQueue().catch((err) => console.error("[ai-worker] drain error", err));
  }, 50);
}

async function claimNextJob(): Promise<{ id: string; jobId: string } | null> {
  return db.$transaction(async (tx) => {
    const job = await tx.aIProcessingJob.findFirst({
      where: { status: "QUEUED" },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, jobId: true },
    });
    if (!job) return null;
    const claimed = await tx.aIProcessingJob.updateMany({
      where: { id: job.id, status: "QUEUED" }, // conditional — atomic claim
      data: { status: "PROCESSING", startedAt: new Date(), stage: "Claimed" },
    });
    return claimed.count === 1 ? job : null;
  });
}

// ============================================================
// WORKER EXECUTION MODEL (spec §55, adapted honestly to this
// deployment): the queue SUPPORTS concurrency (claim is atomic and
// maxConcurrentJobs is configurable), but the in-process worker
// drains SERIALLY. Reason: SQLite permits a single writer and the
// extraction stages invoke external binaries synchronously —
// parallel jobs would block the event loop and starve open
// transactions. Serial draining is the correct MVP behavior; the
// claim protocol already supports parallel workers when the queue
// moves to an external broker/PostgreSQL.
// ============================================================
let draining = false;

export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const claimed = await claimNextJob();
      if (!claimed) return;
      try {
        await runJob(claimed.id, claimed.jobId);
      } catch (err) {
        console.error("[ai-worker] job crashed", claimed.jobId, err);
        await db.aIProcessingJob
          .updateMany({
            where: { id: claimed.id, status: "PROCESSING" },
            data: { status: "FAILED", errorCode: "INTERNAL_ERROR", errorMessage: "AI processing failed unexpectedly.", completedAt: new Date() },
          })
          .catch(() => undefined);
      }
    }
  } finally {
    draining = false;
  }
}

async function runJob(internalId: string, jobId: string): Promise<void> {
  const job = await db.aIProcessingJob.findUnique({ where: { id: internalId } });
  if (!job) return;
  const config = await getAIConfig();

  const { provider, fallbackReason } = await resolveAIProvider();
  const prov = provider.provenance();

  await db.aIProcessingJob.update({
    where: { id: internalId },
    data: {
      stage: "Starting",
      modelProvider: prov.provider,
      modelName: prov.modelName,
      modelVersion: prov.modelVersion,
    },
  });
  await appendAuditEvent({
    eventType: "AI_JOB_STARTED",
    caseId: job.caseRef,
    documentId: job.documentRef ?? null,
    metadata: { jobId, jobType: job.jobType, provider: prov.provider, model: prov.modelName },
  }).catch(() => undefined);

  const stageFailures: Array<{ stage: string; code: string; message: string }> = [];
  const artifacts: Record<string, unknown> = {};
  const context = new PipelineContext(job, prov, config);

  try {
    const stages = stagesFor(job.jobType, job);
    for (const stage of stages) {
      await db.aIProcessingJob.update({ where: { id: internalId }, data: { stage: stage.label } });
      try {
        await stage.run(context, artifacts);
      } catch (err) {
        stageFailures.push({
          stage: stage.label,
          code: err instanceof TextExtractionError || err instanceof OcrLanguageUnavailableError || err instanceof AIOutputValidationError ? err.code : "AI_EXTRACTION_FAILED",
          message: err instanceof Error ? err.message.slice(0, 300) : "Stage failed.",
        });
        if (stage.fatal) throw err;
      }
    }
  } catch (err) {
    const code =
      err instanceof TextExtractionError
        ? err.code
        : err instanceof OcrLanguageUnavailableError
          ? err.code
          : err instanceof AIOutputValidationError
            ? err.code
            : err instanceof LocalOnlyBlockedError
              ? err.code
              : "AI_EXTRACTION_FAILED";
    await db.aIProcessingJob.update({
      where: { id: internalId },
      data: { status: "FAILED", errorCode: code, errorMessage: safeMessage(err), completedAt: new Date(), stage: "Failed" },
    });
    await appendAuditEvent({
      eventType: "AI_JOB_FAILED",
      caseId: job.caseRef,
      documentId: job.documentRef ?? null,
      metadata: { jobId, jobType: job.jobType, errorCode: code, failures: stageFailures.map((f) => f.stage) },
    }).catch(() => undefined);
    return;
  }

  const status = stageFailures.length === 0 ? "COMPLETED" : "PARTIAL";
  const summary: Record<string, unknown> = { ...artifacts, stageFailures };
  if (fallbackReason) summary.providerFallback = fallbackReason;
  await db.aIProcessingJob.update({
    where: { id: internalId },
    data: {
      status,
      resultSummary: JSON.stringify(summary).slice(0, 4000),
      completedAt: new Date(),
      stage: status === "COMPLETED" ? "Completed" : "Partial",
    },
  });
  await appendAuditEvent({
    eventType: status === "COMPLETED" ? "AI_JOB_COMPLETED" : "AI_JOB_FAILED",
    caseId: job.caseRef,
    documentId: job.documentRef ?? null,
    result: status === "COMPLETED" ? "SUCCESS" : "FAILED",
    metadata: { jobId, jobType: job.jobType, status, artifacts: Object.keys(artifacts), failures: stageFailures.map((f) => f.stage) },
  }).catch(() => undefined);
}

function safeMessage(err: unknown): string {
  if (err instanceof OcrLanguageUnavailableError) return err.message;
  if (err instanceof TextExtractionError) return err.message;
  if (err instanceof AIOutputValidationError) return "The AI model returned an invalid structure; the output was rejected.";
  if (err instanceof LocalOnlyBlockedError) return err.message;
  return "AI processing could not complete this request.";
}

// ------------------------------------------------------------
// Pipeline stages
// ------------------------------------------------------------

type JobRow = NonNullable<Awaited<ReturnType<typeof db.aIProcessingJob.findUnique>>>;

class PipelineContext {
  constructor(
    public job: JobRow,
    public prov: { provider: string; modelName: string; modelVersion: string },
    public config: Awaited<ReturnType<typeof getAIConfig>>
  ) {}
  /** Pages of normalized text cached across stages. */
  pages: SourcePage[] = [];
  pagesLoaded = false;
  /** Snapshot cache for entity upsert dedupe within one run. */
  seenEntityKeys = new Set<string>();
}

interface Stage {
  label: string;
  fatal?: boolean;
  run(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void>;
}

function stagesFor(jobType: string, job: JobRow): Stage[] {
  switch (jobType) {
    case "OCR":
      return [{ label: "Text extraction (OCR)", fatal: true, run: (c, a) => extractionStage(c, a, true) }];
    case "TEXT_EXTRACTION":
      return [{ label: "Text extraction", fatal: true, run: (c, a) => extractionStage(c, a, false) }];
    case "CLASSIFICATION":
      return [
        { label: "Text extraction", fatal: true, run: (c, a) => loadOrCreateText(c, a) },
        { label: "Classification", run: classificationStage },
      ];
    case "ENTITY_EXTRACTION":
      return [
        { label: "Text extraction", fatal: true, run: (c, a) => loadOrCreateText(c, a) },
        { label: "Entity extraction", run: entityStage },
        { label: "Entity matching", run: entityMatchStage },
      ];
    case "SUMMARY":
      return job.documentId
        ? [
            { label: "Text extraction", fatal: true, run: (c, a) => loadOrCreateText(c, a) },
            { label: "Summarization", run: summaryStage },
          ]
        : [{ label: "Case summary", run: caseSummaryStage }];
    case "TIMELINE_EXTRACTION":
      return job.documentId
        ? [
            { label: "Text extraction", fatal: true, run: (c, a) => loadOrCreateText(c, a) },
            { label: "Timeline extraction", run: timelineStage },
          ]
        : [{ label: "Case timeline extraction", run: caseTimelineStage }];
    case "EMBEDDING":
    case "SEMANTIC_INDEXING":
      return [
        { label: "Text extraction", fatal: true, run: (c, a) => loadOrCreateText(c, a) },
        { label: "Chunking", run: chunkStage },
        { label: "Embeddings", run: embeddingStage },
      ];
    case "RELATIONSHIP_DISCOVERY":
      return [{ label: "Relationship discovery", run: relationshipStage }];
    case "FULL_ANALYSIS":
      return [
        { label: "Text extraction", fatal: true, run: (c, a) => extractionStage(c, a, false) },
        { label: "Entity extraction", run: entityStage },
        { label: "Entity matching", run: entityMatchStage },
        { label: "Classification", run: classificationStage },
        { label: "Summarization", run: summaryStage },
        { label: "Timeline extraction", run: timelineStage },
        { label: "Chunking", run: chunkStage },
        { label: "Embeddings", run: embeddingStage },
        { label: "Relationship discovery", run: relationshipStage },
      ];
    default:
      throw new TextExtractionError("VALIDATION_ERROR", `Unknown AI job type: ${jobType}`);
  }
}

async function loadOrCreateText(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  if (ctx.pagesLoaded) return;
  const rows = await db.documentText.findMany({
    where: { documentId: ctx.job.documentId! },
    orderBy: { pageNumber: "asc" },
  });
  if (!rows.length) {
    await extractionStage(ctx, artifacts, false);
    return;
  }
  ctx.pages = rows.map((r) => ({ pageNumber: r.pageNumber, text: r.text }));
  ctx.pagesLoaded = true;
  artifacts.textPages = rows.length;
}

async function extractionStage(ctx: PipelineContext, artifacts: Record<string, unknown>, ocrOnly: boolean): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! } });
  if (!document) throw new TextExtractionError("AI_EXTRACTION_FAILED", "Document record disappeared.");

  // Decrypt in-memory via the storage abstraction — original object untouched.
  const { getDocumentObjectBytes } = await import("@/lib/documents/read");
  const bytes = await getDocumentObjectBytes(document);

  const result = await DocumentTextExtractor.extract_text(bytes, {
    mimeType: document.mimeType,
    fileExtension: document.fileExtension,
  });

  // Persist normalized text + OCR results
  for (const page of result.pages) {
    const previous = await db.documentText.findUnique({
      where: { documentId_pageNumber: { documentId: document.id, pageNumber: page.pageNumber } },
    });
    if (previous && previous.text !== page.text) {
      // Snapshot superseded derived text (spec §29/§41) — the original file stays untouched.
      const versionCount = await db.aIResultVersion.count({
        where: { resultType: "DOCUMENT_TEXT", sourceInternalId: previous.id },
      });
      await db.aIResultVersion.create({
        data: {
          resultType: "DOCUMENT_TEXT",
          sourceRef: document.documentId,
          sourceInternalId: previous.id,
          versionNumber: versionCount + 1,
          modelProvider: previous.sourceType === "OCR" ? "tesseract" : previous.sourceType.toLowerCase(),
          modelName: previous.sourceReference || previous.sourceType,
          inputReference: document.sha256Hash.slice(0, 16),
          outputReference: JSON.stringify({ text: previous.text.slice(0, 2000), sourceType: previous.sourceType }),
        },
      });
    }
    await db.documentText.upsert({
      where: { documentId_pageNumber: { documentId: document.id, pageNumber: page.pageNumber } },
      create: {
        documentId: document.id,
        pageNumber: page.pageNumber,
        text: page.text,
        language: page.language.language,
        languageConfidence: page.language.confidence,
        sourceType: page.extractionMethod === "OCR" ? "OCR" : "NATIVE_TEXT",
        sourceReference: `${page.provider}${page.modelVersion ? `@${page.modelVersion}` : ""}`,
        extractionConfidence: page.confidence,
        jobId: ctx.job.jobId,
      },
      update: {
        text: page.text,
        language: page.language.language,
        languageConfidence: page.language.confidence,
        sourceType: page.extractionMethod === "OCR" ? "OCR" : "NATIVE_TEXT",
        sourceReference: `${page.provider}${page.modelVersion ? `@${page.modelVersion}` : ""}`,
        extractionConfidence: page.confidence,
        jobId: ctx.job.jobId,
      },
    });
    if (page.extractionMethod === "OCR" && page.provider === "tesseract") {
      await db.ocrResult.upsert({
        where: { documentId_pageNumber_provider: { documentId: document.id, pageNumber: page.pageNumber, provider: "tesseract" } },
        create: {
          documentId: document.id,
          pageNumber: page.pageNumber,
          recognizedText: page.text,
          language: page.language.language,
          confidence: page.confidence,
          provider: "tesseract",
          modelVersion: page.modelVersion,
          jobId: ctx.job.jobId,
        },
        update: {
          recognizedText: page.text,
          confidence: page.confidence,
          language: page.language.language,
          modelVersion: page.modelVersion,
          jobId: ctx.job.jobId,
        },
      });
    }
  }

  ctx.pages = result.pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text, documentRef: document.documentId }));
  ctx.pagesLoaded = true;
  artifacts.textPages = result.pages.length;
  artifacts.ocrUsed = result.ocrUsed;
  artifacts.language = result.language.language;
  if (result.warnings.length) artifacts.extractionWarnings = result.warnings.slice(0, 10);
  if (result.ocrUsed) {
    await appendAuditEvent({
      eventType: "AI_OCR_COMPLETED",
      caseId: ctx.job.caseRef,
      documentId: document.documentId,
      metadata: { jobId: ctx.job.jobId, pages: result.pages.length, language: result.language.language },
    }).catch(() => undefined);
  }
  void ocrOnly;
}

async function entityStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! }, select: { documentId: true, caseId: true } });
  if (!document) return;
  const { provider } = await resolveAIProvider();
  const prov = provider.provenance();
  const drafts = await withTimeout(provider.extractEntities({ pages: ctx.pages }), 60_000, "entity");

  // Verified entities are NEVER removed or overwritten by reprocessing.
  const verified = await db.extractedEntity.findMany({
    where: { documentId: ctx.job.documentId!, reviewStatus: { in: ["VERIFIED", "REJECTED"] } },
    select: { entityType: true, normalizedValue: true, originalText: true, pageNumber: true },
  });
  const verifiedKeys = new Set(
    verified.map((v) => `${v.entityType}|${(v.normalizedValue || v.originalText).toLowerCase()}|${v.pageNumber}`)
  );

  let created = 0;
  let skippedVerified = 0;
  for (const d of drafts) {
    const key = `${d.entityType}|${(d.normalizedValue || d.originalText).toLowerCase()}|${d.pageNumber}`;
    if (verifiedKeys.has(key)) {
      skippedVerified++;
      continue;
    }
    if (ctx.seenEntityKeys.has(key)) continue;
    ctx.seenEntityKeys.add(key);
    const existing = await db.extractedEntity.findFirst({
      where: {
        documentId: ctx.job.documentId!,
        entityType: d.entityType,
        pageNumber: d.pageNumber,
        OR: [{ normalizedValue: d.normalizedValue ?? null }, { originalText: d.originalText }],
      },
      select: { id: true },
    });
    if (existing) continue;
    await db.extractedEntity.create({
      data: {
        documentId: ctx.job.documentId!,
        caseRef: ctx.job.caseRef,
        entityType: d.entityType,
        originalText: d.originalText.slice(0, 300),
        normalizedValue: d.normalizedValue?.slice(0, 300) ?? null,
        pageNumber: d.pageNumber,
        startOffset: d.startOffset ?? null,
        endOffset: d.endOffset ?? null,
        confidence: d.confidence,
        sourceReference: `${document.documentId}|page ${d.pageNumber}|offset ${d.startOffset ?? "?"}`,
        modelProvider: prov.provider,
        modelName: prov.modelName,
        modelVersion: prov.modelVersion,
        reviewStatus: "PENDING",
        jobId: ctx.job.jobId,
      },
    });
    created++;
  }
  artifacts.entitiesCreated = created;
  artifacts.entitiesSkippedVerified = skippedVerified;
  await appendAuditEvent({
    eventType: "AI_ENTITY_EXTRACTION_COMPLETED",
    caseId: ctx.job.caseRef,
    documentId: document.documentId,
    metadata: { jobId: ctx.job.jobId, created, provider: prov.provider, model: prov.modelName },
  }).catch(() => undefined);
}

async function entityMatchStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  // Candidate matching ONLY — never an automatic merge (spec §13).
  const persons = await db.extractedEntity.findMany({
    where: { caseRef: ctx.job.caseRef, entityType: "PERSON" },
    select: { id: true, normalizedValue: true, originalText: true },
  });
  let suggested = 0;
  for (let i = 0; i < persons.length; i++) {
    for (let j = i + 1; j < persons.length; j++) {
      const a = persons[i];
      const b = persons[j];
      const aName = (a.normalizedValue || a.originalText).toLowerCase();
      const bName = (b.normalizedValue || b.originalText).toLowerCase();
      if (aName === bName) continue; // identical names are not "candidates" — they are the same surface form
      const aTokens = new Set(aName.split(/\s+/));
      const bTokens = new Set(bName.split(/\s+/));
      const overlap = [...aTokens].filter((t) => bTokens.has(t)).length;
      const union = new Set([...aTokens, ...bTokens]).size;
      const jaccard = overlap / Math.max(union, 1);
      const subset = (overlap > 0 && (aName.includes(bName) || bName.includes(aName))) ? 0.45 : 0;
      const score = Math.max(jaccard, subset);
      if (score < 0.34) continue;
      const [aId, bId] = [a.id, b.id].sort();
      const exists = await db.entityCandidateMatch.findUnique({
        where: { entityAId_entityBId: { entityAId: aId, entityBId: bId } },
        select: { id: true },
      });
      if (exists) continue;
      await db.entityCandidateMatch.create({
        data: {
          entityAId: aId,
          entityBId: bId,
          similarityScore: Math.round(score * 100) / 100,
          matchReason: `Shared name tokens (${overlap}); requires human confirmation — similarity never implies identity.`,
          status: "SUGGESTED",
        },
      });
      suggested++;
    }
  }
  if (suggested) artifacts.entityMatchSuggestions = suggested;
}

async function classificationStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({
    where: { id: ctx.job.documentId! },
    select: { documentId: true, documentType: true },
  });
  if (!document) return;
  const { provider, fallbackReason } = await resolveAIProvider();
  const prov = provider.provenance();
  let suggestion;
  try {
    suggestion = await withTimeout(provider.classifyDocument({ pages: ctx.pages, currentType: document.documentType }), 60_000, "classification");
  } catch (err) {
    if (err instanceof AIOutputValidationError || err instanceof LocalOnlyBlockedError) {
      // Malformed/blocked model output → deterministic local re-classification (spec §52).
      suggestion = await HeuristicAIProvider.classifyDocument({ pages: ctx.pages, currentType: document.documentType });
      await recordAuditEvent({
        eventType: "AI_PROVIDER_FAILURE",
        caseId: ctx.job.caseRef,
        documentId: document.documentId,
        metadata: { jobId: ctx.job.jobId, op: "classification", code: err instanceof AIOutputValidationError ? "AI_OUTPUT_INVALID" : err.code },
      });
    } else throw err;
  }
  const row = await db.aIDocumentClassification.create({
    data: {
      documentId: ctx.job.documentId!,
      caseRef: ctx.job.caseRef,
      suggestedType: suggestion.suggestedType,
      suggestedCategory: suggestion.suggestedCategory ?? null,
      confidence: suggestion.confidence,
      reason: suggestion.reason ?? null,
      sourceReference: suggestion.sourceReference ?? null,
      modelProvider: prov.provider,
      modelName: prov.modelName,
      modelVersion: prov.modelVersion,
      reviewStatus: "PENDING",
      jobId: ctx.job.jobId,
    },
  });
  // Version lineage: snapshot the previous latest suggestion (spec §29)
  const previous = await db.aIDocumentClassification.findFirst({
    where: { documentId: ctx.job.documentId!, id: { not: row.id } },
    orderBy: { createdAt: "desc" },
    select: { id: true, suggestedType: true, confidence: true, modelProvider: true, modelName: true },
  });
  if (previous) {
    const versionCount = await db.aIResultVersion.count({
      where: { resultType: "CLASSIFICATION", sourceInternalId: ctx.job.documentId! },
    });
    await db.aIResultVersion.create({
      data: {
        resultType: "CLASSIFICATION",
        sourceRef: document.documentId,
        sourceInternalId: ctx.job.documentId!,
        versionNumber: versionCount + 1,
        modelProvider: previous.modelProvider,
        modelName: previous.modelName,
        inputReference: document.documentId,
        outputReference: JSON.stringify(previous),
      },
    });
  }
  artifacts.classificationId = row.id;
  artifacts.suggestedType = suggestion.suggestedType;
  artifacts.confidence = suggestion.confidence;
  if (fallbackReason) artifacts.providerFallback = fallbackReason;
  await appendAuditEvent({
    eventType: "AI_CLASSIFICATION_CREATED",
    caseId: ctx.job.caseRef,
    documentId: document.documentId,
    metadata: { jobId: ctx.job.jobId, suggestedType: suggestion.suggestedType, confidence: suggestion.confidence, provider: prov.provider },
  }).catch(() => undefined);
}

async function summaryStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! }, select: { documentId: true, title: true } });
  if (!document) return;
  const { provider } = await resolveAIProvider();
  const prov = provider.provenance();
  const drafts: Array<{ summaryType: string; summaryText: string; sourceReferences: Array<{ pageNumber: number; quote: string }> }> = [];
  for (const summaryType of ["SHORT", "DETAILED"]) {
    try {
      drafts.push(await withTimeout(provider.summarize({ pages: ctx.pages, summaryType, documentTitle: document.title }), 60_000, "summary"));
    } catch (err) {
      if (err instanceof AIOutputValidationError || err instanceof LocalOnlyBlockedError) {
        drafts.push(await HeuristicAIProvider.summarize({ pages: ctx.pages, summaryType, documentTitle: document.title }));
      } else throw err;
    }
  }
  const created: string[] = [];
  for (const draft of drafts) {
    // Version lineage: snapshot the previous latest summary of this type (spec §29)
    const previous = await db.aIDocumentSummary.findFirst({
      where: { documentId: ctx.job.documentId!, summaryType: draft.summaryType },
      orderBy: { createdAt: "desc" },
    });
    if (previous) {
      const versionCount = await db.aIResultVersion.count({
        where: { resultType: "SUMMARY", sourceInternalId: previous.id },
      });
      await db.aIResultVersion.create({
        data: {
          resultType: "SUMMARY",
          sourceRef: document.documentId,
          sourceInternalId: previous.id,
          versionNumber: versionCount + 1,
          modelProvider: previous.modelProvider,
          modelName: previous.modelName,
          inputReference: document.documentId,
          outputReference: JSON.stringify({ summaryText: previous.summaryText.slice(0, 1000) }),
        },
      });
    }
    const row = await db.aIDocumentSummary.create({
      data: {
        documentId: ctx.job.documentId!,
        caseRef: ctx.job.caseRef,
        summaryType: draft.summaryType,
        summaryText: draft.summaryText,
        sourceReferences: JSON.stringify(draft.sourceReferences.slice(0, 12)),
        modelProvider: prov.provider,
        modelName: prov.modelName,
        modelVersion: prov.modelVersion,
        reviewStatus: "PENDING",
        jobId: ctx.job.jobId,
      },
    });
    created.push(row.id);
  }
  artifacts.summaries = created.length;
  await appendAuditEvent({
    eventType: "AI_SUMMARY_CREATED",
    caseId: ctx.job.caseRef,
    documentId: document.documentId,
    metadata: { jobId: ctx.job.jobId, count: created.length, provider: prov.provider, model: prov.modelName },
  }).catch(() => undefined);
}

async function timelineStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! }, select: { documentId: true } });
  if (!document) return;
  const { provider } = await resolveAIProvider();
  const prov = provider.provenance();
  const drafts = await withTimeout(provider.extractTimeline({ pages: ctx.pages }), 60_000, "timeline");

  let created = 0;
  const caseEvents: Array<{ id: string; date: Date | null; text: string; page: number; type: string; desc: string }> = [];
  for (const d of drafts) {
    const description = d.description.slice(0, 240);
    const identityHash = createHash("sha256")
      .update(`${d.eventType}|${d.eventDate?.toISOString().slice(0, 10) ?? d.eventDateText ?? ""}|${description}`)
      .digest("hex")
      .slice(0, 24);
    const existing = await db.aITimelineEvent.findFirst({
      where: { caseRef: ctx.job.caseRef, documentId: ctx.job.documentId!, description },
      select: { id: true },
    });
    if (existing) {
      caseEvents.push({ id: existing.id, date: d.eventDate ?? null, text: d.eventDateText || "", page: d.pageNumber, type: d.eventType, desc: description });
      continue;
    }
    const row = await db.aITimelineEvent.create({
      data: {
        caseId: ctx.job.caseId,
        caseRef: ctx.job.caseRef,
        documentId: ctx.job.documentId!,
        documentRef: document.documentId,
        eventDate: d.eventDate ?? null,
        eventDateText: d.eventDateText ?? null,
        eventTime: d.eventTime ?? null,
        eventType: d.eventType,
        description,
        sourceReference: `${document.documentId}|page ${d.pageNumber}`,
        confidence: d.confidence,
        modelProvider: prov.provider,
        modelName: prov.modelName,
        modelVersion: prov.modelVersion,
        reviewStatus: "PENDING",
        jobId: ctx.job.jobId,
      },
    });
    caseEvents.push({ id: row.id, date: d.eventDate ?? null, text: d.eventDateText || "", page: d.pageNumber, type: d.eventType, desc: description });
    created++;
  }
  artifacts.timelineEvents = created;

  // Conflict detection (spec §18): same event type + overlapping
  // descriptions + different dates → DATE_MISMATCH. Detection spans
  // ALL AI timeline events of the case (cross-document); the AI
  // never decides which date is correct.
  const conflicts = await detectCaseTimelineConflicts(ctx.job.caseRef);
  if (conflicts) artifacts.timelineConflicts = conflicts;
  await appendAuditEvent({
    eventType: "AI_TIMELINE_CREATED",
    caseId: ctx.job.caseRef,
    documentId: document.documentId,
    metadata: { jobId: ctx.job.jobId, events: created, conflicts, provider: prov.provider },
  }).catch(() => undefined);
}

/** Cross-document conflict detection over ALL case events (idempotent by unique pair). */
async function detectCaseTimelineConflicts(caseRef: string): Promise<number> {
  const all = await db.aITimelineEvent.findMany({
    where: { caseRef },
    select: { id: true, eventType: true, eventDate: true, description: true },
  });
  let conflicts = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.eventType !== b.eventType || a.eventType === "OTHER") continue;
      if (!a.eventDate || !b.eventDate) continue;
      if (a.eventDate.getTime() === b.eventDate.getTime()) continue;
      if (tokenOverlap(a.description, b.description) < 0.3) continue;
      const [aId, bId] = [a.id, b.id].sort();
      const exists = await db.aITimelineConflict.findUnique({
        where: { eventAId_eventBId: { eventAId: aId, eventBId: bId } },
        select: { id: true },
      });
      if (exists) continue;
      await db.aITimelineConflict.create({
        data: {
          caseRef,
          eventAId: aId,
          eventBId: bId,
          conflictType: "DATE_MISMATCH",
          description: `Sources reference the same type of event (${a.eventType}) on different dates: ${a.eventDate.toISOString().slice(0, 10)} vs ${b.eventDate.toISOString().slice(0, 10)}. Human review decides which date is correct.`,
          status: "UNREVIEWED",
        },
      });
      conflicts++;
    }
  }
  return conflicts;
}

function tokenOverlap(a: string, b: string): number {
  const at = new Set(a.toLowerCase().match(/[a-z\u0900-\u097F0-9]+/g) || []);
  const bt = new Set(b.toLowerCase().match(/[a-z\u0900-\u097F0-9]+/g) || []);
  const overlap = [...at].filter((t) => bt.has(t)).length;
  return overlap / Math.max(new Set([...at, ...bt]).size, 1);
}

/** Case-level timeline job: extract per authorized document, then detect conflicts case-wide. */
async function caseTimelineStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const config = await getAIConfig();
  const scope = await buildAuthorizedScopeForCase(ctx.job.caseRef);
  const docs = await db.caseDocument.findMany({
    where: { caseId: ctx.job.caseId, status: { in: ["COMMITTED", "SUPERSEDED"] } },
    select: { id: true, documentId: true, classification: true },
  });
  const allowed = docs.filter((d) => (DOCUMENT_CLASSIFICATION_LEVEL[d.classification] ?? 99) <= scope.clearance);
  let processed = 0;
  const subCtx = new PipelineContext(ctx.job, ctx.prov, config);
  for (const doc of allowed) {
    subCtx.job = { ...ctx.job, documentId: doc.id, documentRef: doc.documentId } as JobRow;
    subCtx.pagesLoaded = false;
    subCtx.pages = [];
    try {
      await loadOrCreateText(subCtx, artifacts);
      await timelineStage(subCtx, artifacts);
      processed++;
    } catch (err) {
      console.error(`[ai-worker] case timeline: doc ${doc.documentId} failed`, err);
    }
  }
  const conflicts = await detectCaseTimelineConflicts(ctx.job.caseRef);
  artifacts.caseTimeline = { documentsProcessed: processed, documentsAuthorized: allowed.length, conflictsDetected: conflicts };
}

/** Case-level summary job — delegates to the shared case summary builder (qa.ts). */
async function caseSummaryStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const { generateCaseSummary } = await import("./qa");
  const scope = await buildAuthorizedScopeForCase(ctx.job.caseRef);
  const result = await generateCaseSummary({
    ctx: {
      sessionId: "ai-worker",
      officer: { id: ctx.job.requestedByOfficerId, officerId: "system", name: "AI Worker", email: "", phone: null, designation: "", role: "SYSTEM_ADMIN", status: "ACTIVE", departmentId: ctx.job.requestedByDepartmentId, lastLoginAt: null },
      department: { id: ctx.job.requestedByDepartmentId, departmentCode: "", name: "", departmentType: "", status: "ACTIVE", stateId: "", districtId: "", cityId: "" },
      permissions: [],
    },
    scopeEntry: { caseRef: ctx.job.caseRef, caseInternalId: ctx.job.caseId, clearance: scope.clearance, access: scope.access },
    jobId: ctx.job.jobId,
  });
  artifacts.caseSummaryId = result.summaryId;
}

/** Minimal case scope for internal stages (clearance of the requesting officer). */
async function buildAuthorizedScopeForCase(caseRef: string): Promise<{ clearance: number; access: CaseAccess }> {
  // Case-level jobs are only enqueued by users who already passed case
  // view authorization; extraction inside the worker uses the
  // requesting officer's clearance, re-read here from the stored job.
  const latest = await db.aIProcessingJob.findFirst({ where: { caseRef }, orderBy: { createdAt: "desc" } });
  const ctxOfficer = latest
    ? await db.officer.findUnique({ where: { id: latest.requestedByOfficerId }, include: { department: true } })
    : null;
  if (!ctxOfficer) return { clearance: 4, access: { level: "manage", view: true, manage: true, isCustodianSide: true, isOriginSide: true, assigned: true, reasons: ["worker"] } };
  const { computeCaseAccess } = await import("@/lib/cases/access");
  const { documentViewClearance } = await import("@/lib/documents/authorization");
  const caseRow = await db.case.findFirstOrThrow({
    where: { OR: [{ caseId: caseRef }, { id: caseRef }] },
    include: { departments: true, officers: { where: { status: "ACTIVE" } }, transfers: { where: { status: "REQUESTED" }, select: { toDepartmentId: true } } },
  });
  const authCtx = {
    sessionId: "ai-worker",
    officer: {
      id: ctxOfficer.id,
      officerId: ctxOfficer.officerId,
      name: ctxOfficer.name,
      email: ctxOfficer.email,
      phone: ctxOfficer.phone,
      designation: ctxOfficer.designation,
      role: ctxOfficer.role,
      status: ctxOfficer.status,
      departmentId: ctxOfficer.departmentId,
      lastLoginAt: ctxOfficer.lastLoginAt,
    },
    department: {
      id: ctxOfficer.department.id,
      departmentCode: ctxOfficer.department.departmentCode,
      name: ctxOfficer.department.name,
      departmentType: ctxOfficer.department.departmentType,
      status: ctxOfficer.department.status,
      stateId: ctxOfficer.department.stateId,
      districtId: ctxOfficer.department.districtId,
      cityId: ctxOfficer.department.cityId,
    },
    permissions: [],
  } as AuthContext;
  const access = computeCaseAccess(authCtx, caseRow);
  return { clearance: documentViewClearance(authCtx, access), access };
}

async function chunkStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! }, select: { id: true, documentId: true } });
  if (!document) return;
  const drafts = chunkPages(ctx.pages);
  const chunkIds: string[] = [];
  for (const d of drafts) {
    const row = await db.documentChunk.upsert({
      where: { documentId_pageNumber_chunkIndex: { documentId: document.id, pageNumber: d.pageNumber, chunkIndex: d.chunkIndex } },
      create: {
        documentId: document.id,
        caseRef: ctx.job.caseRef,
        pageNumber: d.pageNumber,
        chunkIndex: d.chunkIndex,
        text: d.text,
        tokenCount: d.tokenCount,
        jobId: ctx.job.jobId,
      },
      update: { text: d.text, tokenCount: d.tokenCount, jobId: ctx.job.jobId },
    });
    chunkIds.push(row.id);
  }
  artifacts.chunks = drafts.length;
  void chunkIds;
}

async function embeddingStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  const document = await db.caseDocument.findUnique({ where: { id: ctx.job.documentId! }, select: { id: true, documentId: true } });
  if (!document) return;
  const provider = await getEmbeddingProvider();
  const prov = provider.provenance();
  const chunks = await db.documentChunk.findMany({
    where: { documentId: document.id },
    select: { id: true, text: true },
    orderBy: [{ pageNumber: "asc" }, { chunkIndex: "asc" }],
  });
  const vectors = await provider.generate_batch_embeddings(chunks.map((c) => c.text));
  let upserts = 0;
  for (let i = 0; i < chunks.length; i++) {
    const previous = await db.documentEmbedding.findUnique({ where: { chunkId: chunks[i].id } });
    if (previous && (previous.modelName !== prov.modelName || previous.provider !== prov.provider)) {
      // Snapshot the superseded embedding (spec §29/§64 model-version test)
      const versionCount = await db.aIResultVersion.count({
        where: { resultType: "EMBEDDING", sourceInternalId: previous.id },
      });
      await db.aIResultVersion.create({
        data: {
          resultType: "EMBEDDING",
          sourceRef: document.documentId,
          sourceInternalId: previous.id,
          versionNumber: versionCount + 1,
          modelProvider: previous.provider,
          modelName: previous.modelName,
          inputReference: chunks[i].id,
          outputReference: JSON.stringify({ dimension: previous.dimension, vectorHash: createHash("sha256").update(previous.vectorJson).digest("hex").slice(0, 16) }),
        },
      });
    }
    await VectorStore.upsert_embedding({
      chunkId: chunks[i].id,
      documentId: document.id,
      documentRef: document.documentId,
      caseRef: ctx.job.caseRef,
      vector: vectors[i],
      prov,
      jobId: ctx.job.jobId,
    });
    upserts++;
  }
  artifacts.embeddings = upserts;
  await appendAuditEvent({
    eventType: "AI_EMBEDDING_COMPLETED",
    caseId: ctx.job.caseRef,
    documentId: document.documentId,
    metadata: { jobId: ctx.job.jobId, count: upserts, provider: prov.provider, model: prov.modelName, dimension: prov.dimension },
  }).catch(() => undefined);
}

async function relationshipStage(ctx: PipelineContext, artifacts: Record<string, unknown>): Promise<void> {
  // AI relationship SUGGESTIONS (spec §32) — never authoritative.
  const docs = await db.caseDocument.findMany({
    where: { caseId: ctx.job.caseId, status: { in: ["COMMITTED", "SUPERSEDED"] } },
    select: { id: true, documentId: true, title: true, documentType: true },
  });
  if (docs.length < 2) {
    artifacts.relationshipSuggestions = 0;
    return;
  }
  const embeddingProvider = await getEmbeddingProvider();
  const prov = embeddingProvider.provenance();

  const chunkRows = await db.documentChunk.findMany({
    where: { caseRef: ctx.job.caseRef },
    select: { id: true, documentId: true, text: true },
  });
  const embeddings = await db.documentEmbedding.findMany({
    where: { caseRef: ctx.job.caseRef },
    select: { chunkId: true, vectorJson: true },
  });
  const vectorByChunk = new Map(embeddings.map((e) => [e.chunkId, e.vectorJson]));
  const chunksByDoc = new Map<string, string[]>();
  for (const c of chunkRows) {
    if (!vectorByChunk.has(c.id)) continue;
    chunksByDoc.set(c.documentId, [...(chunksByDoc.get(c.documentId) || []), vectorByChunk.get(c.id)!]);
  }
  const centroid = async (docId: string): Promise<Float32Array | null> => {
    const vecs = (chunksByDoc.get(docId) || []).slice(0, 20);
    if (!vecs.length) return null;
    const acc = new Float32Array(prov.dimension);
    for (const v of vecs) {
      const arr = JSON.parse(v);
      for (let i = 0; i < acc.length && i < arr.length; i++) acc[i] += arr[i];
    }
    let norm = 0;
    for (let i = 0; i < acc.length; i++) norm += acc[i] * acc[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < acc.length; i++) acc[i] /= norm;
    return acc;
  };
  const fullTexts = new Map<string, string>();
  for (const c of chunkRows) fullTexts.set(c.documentId, (fullTexts.get(c.documentId) || "") + "\n" + c.text);

  let suggestions = 0;
  for (let i = 0; i < docs.length; i++) {
    for (let j = 0; j < docs.length; j++) {
      if (i === j) continue;
      const a = docs[i];
      const b = docs[j];
      const aText = (fullTexts.get(a.id) || "").toLowerCase();
      // Direct reference: A explicitly mentions B's public id or exact title
      const mentions = aText.includes(b.documentId.toLowerCase()) || (b.title.length > 12 && aText.includes(b.title.toLowerCase()));
      const ca = await centroid(a.id);
      const cb = await centroid(b.id);
      const sim = ca && cb ? cosineSimilarity(ca, cb) : 0;
      let relationshipType: string | null = null;
      let confidence = 0;
      let reason = "";
      if (mentions) {
        relationshipType = "REFERENCE";
        confidence = 0.85;
        reason = `Document ${a.documentId} explicitly references ${b.documentId}.`;
      } else if (sim >= 0.55) {
        relationshipType = "RELATED";
        confidence = Math.min(0.9, Math.round(sim * 100) / 100);
        reason = `High semantic similarity (${Math.round(sim * 100)}%) between document contents.`;
      } else if (
        sim >= 0.3 &&
        ((a.documentType === "FORENSIC_REPORT" && b.documentType === "INVESTIGATION_REPORT") ||
          (a.documentType === "INVESTIGATION_REPORT" && b.documentType === "FORENSIC_REPORT"))
      ) {
        relationshipType = "RESULTS_FROM";
        confidence = Math.min(0.8, Math.round(sim * 100) / 100 + 0.1);
        reason = `Forensic and investigation vocabulary overlap (${Math.round(sim * 100)}% similarity) suggests the forensic report results from the referenced investigation.`;
      }
      if (!relationshipType || confidence < 0.3) continue;
      const exists = await db.aIRelationshipSuggestion.findUnique({
        where: { sourceDocumentId_targetDocumentId_relationshipType: { sourceDocumentId: a.id, targetDocumentId: b.id, relationshipType } },
        select: { id: true },
      });
      if (exists) continue;
      await db.aIRelationshipSuggestion.create({
        data: {
          caseRef: ctx.job.caseRef,
          sourceDocumentId: a.id,
          sourceDocumentRef: a.documentId,
          targetDocumentId: b.id,
          targetDocumentRef: b.documentId,
          relationshipType,
          confidence,
          reason,
          sourceReferences: JSON.stringify([{ documentRef: a.documentId }, { documentRef: b.documentId }]),
          status: "SUGGESTED",
          jobId: ctx.job.jobId,
        },
      });
      suggestions++;
    }
  }
  artifacts.relationshipSuggestions = suggestions;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, op: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI_${op}_TIMEOUT`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// Read-path helpers used by APIs
// ------------------------------------------------------------

/** Compute the display status for a document (spec §48). */
export async function documentAIStatus(documentInternalId: string): Promise<{
  status: string;
  activeJobId: string | null;
  lastJobId: string | null;
  lastError: string | null;
}> {
  const last = await db.aIProcessingJob.findFirst({
    where: { documentId: documentInternalId },
    orderBy: { createdAt: "desc" },
    select: { jobId: true, status: true, errorMessage: true },
  });
  const active = await db.aIProcessingJob.findFirst({
    where: { documentId: documentInternalId, status: { in: ["QUEUED", "PROCESSING"] } },
    orderBy: { createdAt: "asc" },
    select: { jobId: true, status: true },
  });
  const hasAny = await db.aIProcessingJob.count({ where: { documentId: documentInternalId } });
  let status = "AI_NOT_PROCESSED";
  if (active) status = active.status === "PROCESSING" ? "AI_PROCESSING" : "AI_QUEUED";
  else if (hasAny) {
    if (!last) status = "AI_NOT_PROCESSED";
    else if (last.status === "COMPLETED") status = "AI_READY";
    else if (last.status === "PARTIAL") status = "AI_PARTIALLY_PROCESSED";
    else if (last.status === "FAILED") status = "AI_PROCESSING_FAILED";
    else if (last.status === "CANCELLED") status = "AI_NOT_PROCESSED";
  }
  return { status, activeJobId: active?.jobId ?? null, lastJobId: last?.jobId ?? null, lastError: last?.errorMessage ?? null };
}

/** Phase 3 commit hook (spec §4): enqueue FULL_ANALYSIS after commit when enabled. */
export async function autoEnqueueAfterCommit(params: {
  ctx: AuthContext;
  caseInternalId: string;
  caseRef: string;
  documentInternalId: string;
  documentRef: string;
}): Promise<void> {
  try {
    const config = await getAIConfig();
    if (!config.aiEnabled || !config.autoProcessOnCommit) return;
    const existing = await db.aIProcessingJob.count({
      where: { documentId: params.documentInternalId, status: { in: ["QUEUED", "PROCESSING"] } },
    });
    if (existing) return;
    await enqueueAIJob({
      ctx: params.ctx,
      jobType: "FULL_ANALYSIS",
      documentId: params.documentInternalId,
      documentRef: params.documentRef,
      caseInternalId: params.caseInternalId,
      caseRef: params.caseRef,
      priority: "LOW",
    });
  } catch (err) {
    // AI enqueue failure must NEVER block document commitment.
    console.error("[ai] auto-enqueue after commit failed (document unaffected)", err);
  }
}
