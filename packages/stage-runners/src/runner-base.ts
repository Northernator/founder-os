/**
 * Shared base for every stage runner.
 *
 * Provides the per-run plumbing every runner needs without forcing each
 * one to reinvent it: a stable runId, an in-memory log buffer with
 * level-tagged helpers, IO helpers that flush logs / append to the
 * artifact index / write review gates via the injected Filesystem port,
 * and a small helper to read review-gate config off the venture
 * manifest. Subclasses implement validate() and run().
 *
 * Why a class rather than free functions: log entries, runId, and the
 * stage name are tightly coupled per-run state -- a class keeps that
 * state private to the runner instance and yields a small public surface
 * for subclasses (this.log, this.runId, this.flushLogs).
 *
 * IO model: Filesystem (the port from @founder-os/pipeline-runner) only
 * exposes mkdir / exists / readFile / writeFile -- no append. So all
 * "append-style" writes (logs, artifact index, review gates) read the
 * existing file (if any), merge in memory, and writeFile the whole thing
 * back. Stage runs are sequential per venture, so the single-writer
 * assumption holds; if that ever stops being true we move to a proper
 * append-only store (jsonl on disk with fs.appendFile).
 */
import type {
  ArtifactIndexEntry,
  LogEntry,
  LogLevel,
  ReviewGate,
  StageName,
  VentureManifest,
} from "@founder-os/domain";
import { DEFAULT_REVIEW_GATES } from "@founder-os/domain";
import type { Filesystem } from "@founder-os/pipeline-runner";
import {
  getArtifactsIndexPath,
  getReviewGatesPath,
  getStageRunLogPath,
} from "@founder-os/workspace-core";

export abstract class BaseStageRunner {
  abstract readonly stageName: StageName;
  protected readonly logs: LogEntry[] = [];
  protected readonly runId: string;

  constructor(
    protected readonly ventureRoot: string,
    protected readonly fs: Filesystem,
    protected readonly manifest: VentureManifest,
    runId?: string
  ) {
    this.runId = runId ?? generateRunId();
  }

  /**
   * Append a structured log entry. Returned to the caller as part of
   * StageRunResult.logs and persisted to .founder/logs/<stage>-<run>.jsonl
   * on flushLogs(). Keep messages short -- the structured `data` payload
   * is the right place for context (counts, paths, error details).
   */
  protected log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (data !== undefined) entry.data = data;
    this.logs.push(entry);
  }

  /**
   * Persist the in-memory logs[] buffer to .founder/logs/<stage>-<run>.jsonl.
   * Called from run() in a finally block so failed runs still leave a
   * trace. One file per (stage, run) so failed-run forensics don't
   * collide with the next attempt.
   */
  protected async flushLogs(): Promise<void> {
    if (this.logs.length === 0) return;
    const path = getStageRunLogPath(this.ventureRoot, this.stageName, this.runId);
    const lines = this.logs.map((entry) => JSON.stringify(entry)).join("\n");
    await this.fs.writeFile(path, `${lines}\n`);
  }

  /**
   * Append entries to .founder/artifacts/index.json. Reads the existing
   * file (treated as a JSON array) and writes back the merged list. If
   * the file doesn't exist yet, starts fresh. If it exists but isn't a
   * JSON array, logs a warning and overwrites with the new entries --
   * the alternative (refusing to write) would silently lose this run's
   * artifacts which is worse.
   */
  protected async appendArtifactIndex(entries: ArtifactIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const path = getArtifactsIndexPath(this.ventureRoot);
    const existing = await readJsonArray<ArtifactIndexEntry>(this.fs, path, (msg) =>
      this.log("warn", `artifact-index parse: ${msg}`)
    );
    await this.fs.writeFile(path, `${JSON.stringify([...existing, ...entries], null, 2)}\n`);
  }

  /**
   * Append a review gate to .founder/state/review-gates.json. Same
   * read-merge-write pattern as appendArtifactIndex.
   */
  protected async appendReviewGate(gate: ReviewGate): Promise<void> {
    const path = getReviewGatesPath(this.ventureRoot);
    const existing = await readJsonArray<ReviewGate>(this.fs, path, (msg) =>
      this.log("warn", `review-gates parse: ${msg}`)
    );
    await this.fs.writeFile(path, `${JSON.stringify([...existing, gate], null, 2)}\n`);
  }

  /**
   * Resolve the StageName -> requires-review decision from the manifest.
   * If `manifest.pipeline.reviewGates` is missing, use DEFAULT_REVIEW_GATES.
   * Returns true iff this runner's stageName is in the configured list.
   */
  protected stageRequiresReview(): boolean {
    const configured = this.manifest.pipeline?.reviewGates ?? DEFAULT_REVIEW_GATES;
    return configured.includes(this.stageName);
  }
}

/**
 * Read a JSON file expected to contain an array of T. Returns [] on any
 * failure (missing file, malformed JSON, non-array root). The optional
 * onWarn callback receives a one-line description when the file existed
 * but couldn't be parsed -- callers usually wire this to runner.log().
 */
async function readJsonArray<T>(
  fs: Filesystem,
  path: string,
  onWarn?: (msg: string) => void
): Promise<T[]> {
  if (!(await fs.exists(path))) return [];
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      onWarn?.(`expected array at ${path}, got ${typeof parsed}`);
      return [];
    }
    return parsed as T[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onWarn?.(`failed to read ${path}: ${msg}`);
    return [];
  }
}

/**
 * Generate a short, sortable, opaque run id. Format: "<base36 ts>-<rand>".
 * Avoids importing crypto/uuid -- this id is internal (filenames, log
 * correlation), not security-sensitive.
 */
export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}
