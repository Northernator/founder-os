/**
 * Job-level orchestration for the Dream Vault import pipeline.
 *
 * Provider-agnostic: takes already-resolved candidate items (path or paste
 * payload) and walks them through staging, hashing, dedupe, and source-doc
 * creation. The local-file-importer (slice 2) feeds us file paths; the
 * chat-importer (slice 4) feeds us pre-parsed payloads; the drive importer
 * (slice 5) feeds us downloaded file paths -- all wear the same shape.
 *
 * Filesystem touch points are delegated to the injected ports so this
 * file remains client-safe (zero node:* imports). The Node bindings in
 * ./node/index.ts provide the real hashFile + stageOriginal.
 */

import type {
  ImportJob,
  ImportJobStatus,
  SourceDocument,
  SourceMode,
  SourceProvider,
  SourceType,
} from "@founder-os/vault-contract";
import { detectFileType, extractExtension } from "./file-type";
import { advanceJob, recordFileOutcome } from "./lifecycle";
import type {
  HashFileFn,
  ImportJobStore,
  ImportLogger,
  KnownHashLookup,
  ProgressEmit,
  StageOriginalFn,
} from "./ports";
import { safelyRunPerFile } from "./safely-run";

/** An item the importer wants us to ingest. */
export interface ImportCandidate {
  /** Absolute path on disk that hashFile + stageOriginal can read. */
  absolutePath: string;
  /** User-visible name (filename or external title). */
  originalName: string;
  /** Optional OS-reported mime type. */
  mimeType?: string;
  /** Defaults to the importer's own provider, but can be overridden per item. */
  provider?: SourceProvider;
}

export interface CreateImportJobInput {
  jobId: string;
  workspaceRoot: string;
  provider: SourceProvider;
  mode: SourceMode;
  fileCount: number;
  now: string;
  store: ImportJobStore;
  logger: ImportLogger;
}

export async function createImportJob(input: CreateImportJobInput): Promise<ImportJob> {
  const job: ImportJob = {
    id: input.jobId,
    status: "queued",
    sourceProvider: input.provider,
    sourceMode: input.mode,
    fileCount: input.fileCount,
    processedCount: 0,
    failedCount: 0,
    warningCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    schemaVersion: 1,
  };
  await input.store.insertJob(job);
  input.logger.info("import-core.job.created", {
    jobId: job.id,
    provider: job.sourceProvider,
    mode: job.sourceMode,
    fileCount: job.fileCount,
  });
  return job;
}

export interface ProcessImportJobInput {
  job: ImportJob;
  candidates: ImportCandidate[];
  workspaceRoot: string;
  hashFile: HashFileFn;
  stageOriginal: StageOriginalFn;
  hashLookup: KnownHashLookup;
  store: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;
  nowFn?: () => string;
  /** Optional pluggable id factory; defaults to `src_<8 hex>_<seq>`. */
  sourceIdFactory?: () => string;
}

export interface ProcessImportJobResult {
  job: ImportJob;
  staged: SourceDocument[];
  duplicates: ImportCandidate[];
  failures: Array<{ candidate: ImportCandidate; error: string }>;
}

export async function processImportJob(
  input: ProcessImportJobInput,
): Promise<ProcessImportJobResult> {
  const now = input.nowFn ?? (() => new Date().toISOString());
  const nextId = input.sourceIdFactory ?? defaultSourceIdFactory();

  let job = advanceJob({ job: input.job, to: "processing", now: now() });
  await input.store.updateJobStatus(job.id, "processing");
  input.emit?.({ kind: "job_status", jobId: job.id, status: "processing" });
  input.logger.info("import-core.job.processing", { jobId: job.id });

  const staged: SourceDocument[] = [];
  const duplicates: ImportCandidate[] = [];
  const failures: Array<{ candidate: ImportCandidate; error: string }> = [];

  for (const candidate of input.candidates) {
    const hashed = await safelyRunPerFile(() => input.hashFile(candidate.absolutePath), {
      logger: input.logger,
      step: "hash",
      itemKey: candidate.absolutePath,
    });
    if (!hashed.ok) {
      job = recordFileOutcome({ job, outcome: "failed", now: now() });
      await input.store.incrementCounts(job.id, { failedCount: 1, processedCount: 1 });
      failures.push({ candidate, error: hashed.error.message });
      input.emit?.({
        kind: "file_failed",
        jobId: job.id,
        originalName: candidate.originalName,
        error: hashed.error.message,
      });
      continue;
    }

    if (await input.hashLookup.has(hashed.value)) {
      duplicates.push(candidate);
      job = recordFileOutcome({ job, outcome: "warned", now: now() });
      await input.store.incrementCounts(job.id, { warningCount: 1, processedCount: 1 });
      input.emit?.({
        kind: "file_skipped_duplicate",
        jobId: job.id,
        originalName: candidate.originalName,
      });
      continue;
    }
    await input.hashLookup.add(hashed.value);

    const fileExtension = extractExtension(candidate.originalName);
    const typeResult = detectFileType({
      originalName: candidate.originalName,
      fileExtension,
      mimeType: candidate.mimeType,
    });

    const staging = await safelyRunPerFile(
      () =>
        input.stageOriginal({
          absoluteSourcePath: candidate.absolutePath,
          workspaceRoot: input.workspaceRoot,
          contentHash: hashed.value,
          fileExtension,
        }),
      { logger: input.logger, step: "stage-original", itemKey: candidate.absolutePath },
    );
    if (!staging.ok) {
      job = recordFileOutcome({ job, outcome: "failed", now: now() });
      await input.store.incrementCounts(job.id, { failedCount: 1, processedCount: 1 });
      failures.push({ candidate, error: staging.error.message });
      input.emit?.({
        kind: "file_failed",
        jobId: job.id,
        originalName: candidate.originalName,
        error: staging.error.message,
      });
      continue;
    }

    const doc: SourceDocument = {
      id: nextId(),
      importJobId: job.id,
      sourceType: typeResult.sourceType as SourceType,
      sourceProvider: candidate.provider ?? job.sourceProvider,
      originalName: candidate.originalName,
      mimeType: candidate.mimeType ?? typeResult.inferredMimeType,
      fileExtension: fileExtension || undefined,
      cachedOriginalPath: staging.value.cachedRelativePath,
      contentHash: hashed.value,
      byteSize: staging.value.byteSize,
      extractionStatus: "pending",
      confidence: typeResult.confidence,
      needsReview: typeResult.confidence === "low",
      createdAt: now(),
      schemaVersion: 1,
    };
    await input.store.insertSource(doc);
    staged.push(doc);
    job = recordFileOutcome({ job, outcome: "succeeded", now: now() });
    await input.store.incrementCounts(job.id, { processedCount: 1 });
    input.emit?.({
      kind: "file_staged",
      jobId: job.id,
      sourceDocumentId: doc.id,
      originalName: doc.originalName,
    });
  }

  job = advanceJob({ job, to: "needs_review", now: now() });
  await input.store.updateJobStatus(job.id, "needs_review");
  input.emit?.({ kind: "job_status", jobId: job.id, status: "needs_review" });
  input.logger.info("import-core.job.needs-review", {
    jobId: job.id,
    stagedCount: staged.length,
    duplicateCount: duplicates.length,
    failureCount: failures.length,
  });

  return { job, staged, duplicates, failures };
}

export interface CommitImportJobInput {
  job: ImportJob;
  store: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;
  now: string;
}

export async function commitImportJob(input: CommitImportJobInput): Promise<ImportJob> {
  const next = advanceJob({ job: input.job, to: "committed", now: input.now });
  await input.store.updateJobStatus(next.id, "committed");
  input.emit?.({ kind: "job_status", jobId: next.id, status: "committed" });
  input.logger.info("import-core.job.committed", { jobId: next.id });
  return next;
}

export interface CancelImportJobInput {
  job: ImportJob;
  store: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;
  now: string;
  reason?: string;
}

export async function cancelImportJob(input: CancelImportJobInput): Promise<ImportJob> {
  const next = advanceJob({
    job: input.job,
    to: "cancelled",
    now: input.now,
    errorMessage: input.reason,
  });
  await input.store.updateJobStatus(next.id, "cancelled", input.reason);
  input.emit?.({ kind: "job_status", jobId: next.id, status: "cancelled" });
  input.logger.warn("import-core.job.cancelled", { jobId: next.id, reason: input.reason });
  return next;
}

export interface MarkJobFailedInput {
  job: ImportJob;
  store: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;
  now: string;
  reason: string;
}

export async function markImportJobFailed(input: MarkJobFailedInput): Promise<ImportJob> {
  const next = advanceJob({
    job: input.job,
    to: "failed",
    now: input.now,
    errorMessage: input.reason,
  });
  await input.store.updateJobStatus(next.id, "failed", input.reason);
  input.emit?.({ kind: "job_status", jobId: next.id, status: "failed" });
  input.logger.error("import-core.job.failed", { jobId: next.id, reason: input.reason });
  return next;
}

export function defaultSourceIdFactory(): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    const rand = Math.random().toString(16).slice(2, 10).padStart(8, "0");
    return `src_${rand}_${seq.toString(36)}`;
  };
}

// Re-export the job-status enum so callers don't need a second import.
export type { ImportJobStatus };
