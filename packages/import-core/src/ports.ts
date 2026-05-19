/**
 * Injection-shaped ports the runner wires up. Keeping them as TS-only
 * interfaces lets the Node side and tests provide their own
 * implementations -- no node:* imports leak into the renderer.
 */

import type { ImportJob, ImportJobStatus, SourceDocument } from "@founder-os/vault-contract";

/** sha256 over a file at the given absolute path. Lower-case hex. */
export type HashFileFn = (absolutePath: string) => Promise<string>;

/**
 * Copy/move the original file into the import cache and return the
 * workspace-relative path of the cached copy.
 */
export type StageOriginalFn = (input: {
  absoluteSourcePath: string;
  workspaceRoot: string;
  contentHash: string;
  fileExtension: string;
}) => Promise<{ cachedRelativePath: string; byteSize: number }>;

/** SQLite-backed lifecycle store for ImportJobs and SourceDocuments. */
export interface ImportJobStore {
  insertJob(job: ImportJob): Promise<void>;
  updateJobStatus(jobId: string, status: ImportJobStatus, errorMessage?: string): Promise<void>;
  getJob(jobId: string): Promise<ImportJob | null>;
  incrementCounts(
    jobId: string,
    delta: {
      processedCount?: number;
      failedCount?: number;
      warningCount?: number;
      fileCount?: number;
    },
  ): Promise<void>;
  insertSource(doc: SourceDocument): Promise<void>;
  listSourcesForJob(jobId: string): Promise<SourceDocument[]>;
}

/** Hash dedupe lookup -- "is this hash already in our SQLite index?" */
export interface KnownHashLookup {
  has(contentHash: string): Promise<boolean>;
  add(contentHash: string): Promise<void>;
}

/** Structured progress events for the desktop UI. */
export type ProgressEvent =
  | { kind: "job_started"; jobId: string }
  | { kind: "file_staged"; jobId: string; sourceDocumentId: string; originalName: string }
  | { kind: "file_skipped_duplicate"; jobId: string; originalName: string }
  | { kind: "file_failed"; jobId: string; originalName: string; error: string }
  | { kind: "job_status"; jobId: string; status: ImportJobStatus };

export type ProgressEmit = (event: ProgressEvent) => void;

/** Logger surface used inside import-core -- matches @founder-os/logger. */
export interface ImportLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
