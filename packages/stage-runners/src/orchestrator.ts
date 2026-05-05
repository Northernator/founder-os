/**
 * PipelineOrchestrator
 *
 * Thin coordinator on top of the per-stage runners. The orchestrator
 * owns four things:
 *
 *  1. Running a stage: validate -> run -> persist progress.
 *     The CALLER builds the StageRunner instance with whatever
 *     stage-specific inputs it needs (research needs an intake
 *     transcript; brand needs naming seed hints) and hands the
 *     orchestrator a constructed StageRunner. The orchestrator does
 *     not know about per-stage inputs -- this keeps it stable as
 *     more runners are added.
 *
 *  2. Persisting stage progress to .founder/state/stage-progress.json.
 *     A successful run with nextStageReady=true advances the cursor.
 *     A successful-but-pending-review run does NOT advance -- progress
 *     advances only when the review gate is approved.
 *
 *  3. Review-gate operations: list pending, approve, reject. Approving
 *     a gate advances stage progress for the gate's stage.
 *
 *  4. Failed-run bookkeeping (slice 5):
 *      - persistFailure dumps the full StageRunResult to
 *        .founder/handoffs/failed/<stage>-<run>.result.json AND
 *        appends a slim entry to .founder/state/failed-runs.json so
 *        the desktop can list failed runs without listing a directory.
 *      - listFailedRuns / markFailedRunResolved manage the index.
 *      - runStage(runner, { force }): when force=false (default) and
 *        stage-progress already shows the stage complete, short-circuit
 *        with a synthetic success result. force=true bypasses the
 *        check and re-runs (used by the "Retry" button).
 */
import type {
  FailedRunEntry,
  ReviewGate,
  StageName,
  StageProgress,
  StageRunResult,
  VentureManifest,
} from "@founder-os/domain";
import type { Filesystem } from "@founder-os/pipeline-runner";
import {
  getFailedRunsIndexPath,
  getFailedStageResultPath,
  getReviewGatesPath,
  getStageProgressPath,
} from "@founder-os/workspace-core";
import type { StageRunner } from "./types.js";

export type PipelineOrchestratorOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
};

export type RunStageOpts = {
  /** Fired after the run completes (success or failure). Streams progress to the UI. */
  onResult?: (result: StageRunResult) => void;
  /**
   * When false (default), runStage short-circuits if stage-progress
   * already shows the stage complete -- returns a synthetic success
   * result without invoking the runner. Pass force=true to re-run a
   * completed stage (regenerating brand brief after a manual edit,
   * retrying a previously-failed run, etc).
   */
  force?: boolean;
};

export class PipelineOrchestrator {
  private readonly manifest: VentureManifest;
  private readonly ventureRoot: string;
  private readonly fs: Filesystem;

  constructor(opts: PipelineOrchestratorOpts) {
    this.manifest = opts.manifest;
    this.ventureRoot = opts.ventureRoot;
    this.fs = opts.fs;
  }

  /**
   * Validate, then run, the supplied stage runner.
   * Persists stage progress on success (subject to review-gate rules).
   * Writes failed results to .founder/handoffs/failed/ + failed-runs.json
   * for retry/audit. Idempotency short-circuit when force=false and the
   * stage is already in completedStages.
   */
  async runStage(runner: StageRunner, opts?: RunStageOpts): Promise<StageRunResult> {
    if (!opts?.force) {
      const progress = await this.getStageProgress();
      if (progress?.completedStages.includes(runner.stageName)) {
        const cached: StageRunResult = {
          success: true,
          stageName: runner.stageName,
          runId: `cached-${Date.now().toString(36)}`,
          artifactsCreated: [],
          logs: [
            {
              timestamp: new Date().toISOString(),
              level: "info",
              message: "stage already complete, short-circuit (force=false)",
              data: { stageName: runner.stageName },
            },
          ],
          requiresReview: false,
          nextStageReady: true,
        };
        opts?.onResult?.(cached);
        return cached;
      }
    }

    const validation = await runner.validate();
    if (!validation.valid) {
      const result: StageRunResult = {
        success: false,
        stageName: runner.stageName,
        runId: `validation-${Date.now().toString(36)}`,
        artifactsCreated: [],
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "stage validation failed",
            data: {
              missingResources: validation.missingResources,
              errors: validation.errors,
            },
          },
        ],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: "VALIDATION_FAILED",
          message: [...validation.errors, ...validation.missingResources].join("; "),
          // A validation failure is "recoverable" only in the sense
          // that fixing the underlying config (set the API key, fix
          // appType, etc) and re-running is the path forward. The
          // exact same call won't pass without external action.
          recoverable: false,
        },
      };
      opts?.onResult?.(result);
      await this.persistFailure(result);
      return result;
    }

    const result = await runner.run();
    opts?.onResult?.(result);

    if (!result.success) {
      await this.persistFailure(result);
      return result;
    }

    // If this run is a retry of a previously-failed run, clear the
    // earlier failure entry from the index so the UI doesn't keep
    // surfacing it. Per-run dump under handoffs/failed/ stays for audit.
    await this.markFailedRunResolved(result.stageName);

    // Successful runs that don't require review advance the cursor
    // immediately. Runs that require review wait for approveReviewGate
    // to advance progress -- otherwise downstream stages would see
    // BRAND as "complete" before a name was actually picked.
    if (result.nextStageReady) {
      await this.advanceProgress(result.stageName);
    }
    return result;
  }

  /**
   * Read the current stage-progress.json. Returns null on first run
   * (file doesn't exist yet).
   */
  async getStageProgress(): Promise<StageProgress | null> {
    const path = getStageProgressPath(this.ventureRoot);
    if (!(await this.fs.exists(path))) return null;
    try {
      const raw = await this.fs.readFile(path);
      return JSON.parse(raw) as StageProgress;
    } catch {
      return null;
    }
  }

  /**
   * Read the current review-gates.json. Returns [] when no gates
   * file exists yet (first run for this venture).
   */
  async listReviewGates(): Promise<ReviewGate[]> {
    return this.readReviewGates();
  }

  async listPendingReviewGates(): Promise<ReviewGate[]> {
    const all = await this.readReviewGates();
    return all.filter((g) => g.status === "pending");
  }

  /**
   * Approve a review gate. Advances stage progress for the gate's
   * stage iff the gate exists and is currently pending. Idempotent --
   * approving an already-approved gate is a no-op (callers can
   * safely retry).
   */
  async approveReviewGate(gateId: string, approvedBy: string, feedback?: string): Promise<void> {
    const gates = await this.readReviewGates();
    const gate = gates.find((g) => g.gateId === gateId);
    if (!gate) {
      throw new Error(`review gate not found: ${gateId}`);
    }
    if (gate.status === "approved") return; // idempotent

    gate.status = "approved";
    gate.approvedBy = approvedBy;
    gate.approvedAt = new Date().toISOString();
    if (feedback !== undefined) gate.feedback = feedback;
    await this.writeReviewGates(gates);
    await this.advanceProgress(gate.stageName);
  }

  /**
   * Reject a review gate. Records the rejection (with optional
   * feedback) but does NOT advance stage progress -- the founder
   * needs to re-run the stage to generate fresh artifacts.
   */
  async rejectReviewGate(gateId: string, rejectedBy: string, feedback?: string): Promise<void> {
    const gates = await this.readReviewGates();
    const gate = gates.find((g) => g.gateId === gateId);
    if (!gate) {
      throw new Error(`review gate not found: ${gateId}`);
    }
    if (gate.status === "rejected") return; // idempotent

    gate.status = "rejected";
    gate.approvedBy = rejectedBy;
    gate.approvedAt = new Date().toISOString();
    if (feedback !== undefined) gate.feedback = feedback;
    await this.writeReviewGates(gates);
  }

  /**
   * List all failed runs from the slim index. Per-run StageRunResult
   * dumps live under .founder/handoffs/failed/ and are reachable via
   * each entry's resultPath.
   */
  async listFailedRuns(): Promise<FailedRunEntry[]> {
    return this.readFailedRunsIndex();
  }

  /**
   * Remove all failed-run entries for a given stage from the index.
   * Called automatically by runStage on success (so a successful retry
   * clears the earlier failure). Can be called manually if a user
   * wants to dismiss a failed run without retrying.
   *
   * If runId is provided, removes only that specific entry.
   */
  async markFailedRunResolved(stageName: StageName, runId?: string): Promise<void> {
    const all = await this.readFailedRunsIndex();
    const filtered = runId
      ? all.filter((e) => !(e.stageName === stageName && e.runId === runId))
      : all.filter((e) => e.stageName !== stageName);
    if (filtered.length === all.length) return; // no-op
    await this.writeFailedRunsIndex(filtered);
  }

  // ---- internals ----

  private async advanceProgress(stageName: StageName): Promise<void> {
    const path = getStageProgressPath(this.ventureRoot);
    const now = new Date().toISOString();
    const existing = (await this.getStageProgress()) ?? {
      currentStage: stageName,
      completedStages: [],
      startedAt: now,
    };

    const completed = existing.completedStages.includes(stageName)
      ? existing.completedStages
      : [...existing.completedStages, stageName];

    const next: StageProgress = {
      currentStage: stageName,
      completedStages: completed,
      startedAt: existing.startedAt,
      updatedAt: now,
    };
    await this.fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  }

  private async persistFailure(result: StageRunResult): Promise<void> {
    const dumpPath = getFailedStageResultPath(this.ventureRoot, result.stageName, result.runId);
    try {
      await this.fs.writeFile(dumpPath, `${JSON.stringify(result, null, 2)}\n`);
    } catch (err) {
      // Best-effort: a failure to persist the failure should not mask
      // the original error reported to the caller.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `stage-runners: persistFailure dump write failed for ${result.stageName} ${result.runId}: ${msg}`
      );
    }

    // Append slim entry to the queryable index. Same best-effort
    // approach -- a failed index update doesn't undo the dump.
    try {
      const entry: FailedRunEntry = {
        stageName: result.stageName,
        runId: result.runId,
        failedAt: new Date().toISOString(),
        errorCode: result.error?.code ?? "UNKNOWN",
        errorMessage: result.error?.message ?? "unknown",
        recoverable: result.error?.recoverable ?? true,
        resultPath: dumpPath,
      };
      const all = await this.readFailedRunsIndex();
      await this.writeFailedRunsIndex([...all, entry]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `stage-runners: persistFailure index write failed for ${result.stageName} ${result.runId}: ${msg}`
      );
    }
  }

  private async readReviewGates(): Promise<ReviewGate[]> {
    const path = getReviewGatesPath(this.ventureRoot);
    if (!(await this.fs.exists(path))) return [];
    try {
      const raw = await this.fs.readFile(path);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ReviewGate[]) : [];
    } catch {
      return [];
    }
  }

  private async writeReviewGates(gates: ReviewGate[]): Promise<void> {
    const path = getReviewGatesPath(this.ventureRoot);
    await this.fs.writeFile(path, `${JSON.stringify(gates, null, 2)}\n`);
  }

  private async readFailedRunsIndex(): Promise<FailedRunEntry[]> {
    const path = getFailedRunsIndexPath(this.ventureRoot);
    if (!(await this.fs.exists(path))) return [];
    try {
      const raw = await this.fs.readFile(path);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as FailedRunEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async writeFailedRunsIndex(entries: FailedRunEntry[]): Promise<void> {
    const path = getFailedRunsIndexPath(this.ventureRoot);
    await this.fs.writeFile(path, `${JSON.stringify(entries, null, 2)}\n`);
  }
}
