/**
 * The thin orchestration layer that turns "user picked files / a folder"
 * into "import-core processed a job". The dialog UX is desktop-side
 * (slice 9). This layer just walks paths and hands them to import-core.
 */

import {
  type HashFileFn,
  type ImportCandidate,
  type ImportJobStore,
  type ImportLogger,
  type KnownHashLookup,
  type ProcessImportJobResult,
  type ProgressEmit,
  type StageOriginalFn,
  createImportJob,
  processImportJob,
} from "@founder-os/import-core";
import type { ImportJob } from "@founder-os/vault-contract";
import { type ResolveAbsoluteFileFn, type WalkFolderFn, shouldIngest } from "./walk";

export interface LocalImporterDeps {
  workspaceRoot: string;
  resolveFile: ResolveAbsoluteFileFn;
  walkFolder: WalkFolderFn;
  hashFile: HashFileFn;
  stageOriginal: StageOriginalFn;
  hashLookup: KnownHashLookup;
  store: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;
  /** ISO clock injection -- defaults to new Date().toISOString(). */
  nowFn?: () => string;
  /** Job-id factory -- defaults to `job_<8 hex>`. */
  jobIdFactory?: () => string;
}

export interface IngestFilesInput {
  /** Already-resolved absolute paths (the desktop side calls Tauri's dialog). */
  paths: string[];
}

export interface IngestFolderInput {
  /** Absolute path to the folder root. */
  rootPath: string;
}

export interface LocalImporterResult {
  job: ImportJob;
  processed: ProcessImportJobResult;
}

export async function ingestFiles(
  input: IngestFilesInput,
  deps: LocalImporterDeps,
): Promise<LocalImporterResult> {
  const candidates = await collectCandidatesFromPaths(input.paths, deps);
  return await runJob({ candidates, mode: "files", deps });
}

export async function ingestFolder(
  input: IngestFolderInput,
  deps: LocalImporterDeps,
): Promise<LocalImporterResult> {
  const discovered = await deps.walkFolder(input.rootPath);
  const filtered = discovered.filter((f) => shouldIngest(f.originalName));
  const candidates: ImportCandidate[] = filtered.map((d) => ({
    absolutePath: d.absolutePath,
    originalName: d.originalName,
    mimeType: d.mimeType,
    provider: "local",
  }));
  return await runJob({ candidates, mode: "folder", deps });
}

async function collectCandidatesFromPaths(
  paths: string[],
  deps: LocalImporterDeps,
): Promise<ImportCandidate[]> {
  const out: ImportCandidate[] = [];
  for (const path of paths) {
    const discovered = await deps.resolveFile(path);
    if (!shouldIngest(discovered.originalName)) continue;
    out.push({
      absolutePath: discovered.absolutePath,
      originalName: discovered.originalName,
      mimeType: discovered.mimeType,
      provider: "local",
    });
  }
  return out;
}

async function runJob(args: {
  candidates: ImportCandidate[];
  mode: "files" | "folder";
  deps: LocalImporterDeps;
}): Promise<LocalImporterResult> {
  const { candidates, mode, deps } = args;
  const now = deps.nowFn ?? (() => new Date().toISOString());
  const jobId = (deps.jobIdFactory ?? defaultJobIdFactory)();
  const startedAt = now();

  const job = await createImportJob({
    jobId,
    workspaceRoot: deps.workspaceRoot,
    provider: "local",
    mode,
    fileCount: candidates.length,
    now: startedAt,
    store: deps.store,
    logger: deps.logger,
  });

  const processed = await processImportJob({
    job,
    candidates,
    workspaceRoot: deps.workspaceRoot,
    hashFile: deps.hashFile,
    stageOriginal: deps.stageOriginal,
    hashLookup: deps.hashLookup,
    store: deps.store,
    logger: deps.logger,
    emit: deps.emit,
    nowFn: now,
  });

  return { job: processed.job, processed };
}

function defaultJobIdFactory(): string {
  const rand = Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `job_${rand}`;
}
