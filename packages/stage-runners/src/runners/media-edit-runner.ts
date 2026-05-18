/**
 * MediaEditStageRunner -- promoted from skeletal (slice 3) to real
 * (slice 4 of media-edit arc).
 *
 * Orchestrates three pipeline-runner steps when a MediaEditProvider is
 * injected via opts.provider. When provider is absent, falls back to
 * the slice-3 skeletal path: writes a checkpoint and exits.
 *
 *   1. createOpencutWorkspaceStep -- reads storyboard.json from
 *                                    MEDIA_READY's output, derives
 *                                    EditProjectExport, calls
 *                                    provider.prepareWorkspace() ->
 *                                    writes clip-manifest.md under
 *                                    10_media/edits/.
 *   2. launchOpencutStep         -- calls provider.launch() ->
 *                                    spawns bun dev + opens browser
 *                                    (opencut) OR no-op (config_only).
 *   3. awaitOpencutExportStep    -- calls provider.awaitExport() with
 *                                    expectedPath = getEditedReelPath(),
 *                                    writes edit-receipt.json.
 *
 * Behaviour
 * ---------
 *  - validate() requires manifest.id + name (unchanged from skeletal).
 *  - Drift-protected log strings (asserted by log-strings.test.ts):
 *      "MEDIA_EDIT stage starting"      -- both paths
 *      "media-edit: workspace prepared" -- real path only
 *      "media-edit: editor launched"    -- real path only
 *      "media-edit: export detected"    -- real path only
 *      "media-edit: receipt written"    -- real path only
 *      "media-edit: checkpoint written" -- both paths
 *  - Real path failure modes:
 *      MEDIA_EDIT_NO_UPSTREAM         -- storyboard.json missing
 *      MEDIA_EDIT_LAUNCH_FAILED        -- bun spawn failed / port busy
 *      MEDIA_EDIT_EXPORT_TIMEOUT       -- founder didn't export within
 *                                         the configured window
 *      MEDIA_EDIT_STEP_THREW           -- unhandled exception
 *  - Aborted runs (signal.aborted) finish with success=true and
 *    nextStageReady=false so the founder can resume cleanly.
 *  - MEDIA_EDIT is NOT in DEFAULT_REVIEW_GATES. Opt in via
 *    pipeline.reviewGates -> requiredApproval = "business" (creative
 *    polish; no legal/security implications).
 *  - Idempotent: re-running overwrites manifest + receipt + checkpoint.
 *  - Teardown: when provider exposes teardown(), the runner SIGTERMs
 *    the dev server in a finally block so the founder doesn't leak a
 *    bun process across runs. Slice 5 (desktop wiring) will track the
 *    server lifecycle across the whole MediaEditTab session instead
 *    of per-run -- the contract surface stays the same.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { MediaEditProvider } from "@founder-os/media-edit-core";
import type { Filesystem } from "@founder-os/pipeline-runner";
import {
  awaitOpencutExportStep,
  createOpencutWorkspaceStep,
  launchOpencutStep,
} from "@founder-os/pipeline-runner";
import {
  getEditedReelPath,
  getMediaEditCheckpointPath,
  getMediaEditDir,
} from "@founder-os/workspace-core";

import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type MediaEditStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
  /**
   * Optional clock injection for tests.
   */
  now?: () => Date;
  /**
   * MediaEditProvider to drive the real path. When absent, the runner
   * falls back to the slice-3 skeletal path (checkpoint only). The
   * desktop helper constructs the right provider based on
   * manifest.mediaEdit.engine; tests pass a fake.
   */
  provider?: MediaEditProvider;
  /**
   * Optional override for awaitExport's poll window. Defaults to the
   * provider's own DEFAULT_AWAIT_EXPORT_TIMEOUT_MS. Mostly a test seam.
   */
  awaitTimeoutMs?: number;
  /**
   * Optional AbortSignal propagated into awaitExport.
   */
  signal?: AbortSignal;
};

export class MediaEditStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "MEDIA_EDIT";
  private readonly now: () => Date;
  private readonly provider: MediaEditProvider | undefined;
  private readonly awaitTimeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(opts: MediaEditStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.now = opts.now ?? (() => new Date());
    this.provider = opts.provider;
    this.awaitTimeoutMs = opts.awaitTimeoutMs;
    this.signal = opts.signal;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for media-edit stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for media-edit stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "MEDIA_EDIT stage starting", {
      runId: this.runId,
      requiresReview,
      enabled: this.manifest.mediaEdit?.enabled === true,
      engine: this.manifest.mediaEdit?.engine ?? "opencut",
      withProvider: this.provider !== undefined,
    });

    if (this.provider === undefined) {
      return this.runSkeletal(requiresReview);
    }
    return this.runReal(requiresReview, this.provider);
  }

  // -------------------------------------------------------------------
  // Skeletal back-compat path (slice 3 behaviour)
  // -------------------------------------------------------------------
  private async runSkeletal(_requiresReview: boolean): Promise<StageRunResult> {
    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = this.now().toISOString();

    try {
      const editsDir = getMediaEditDir(this.ventureRoot);
      await this.fs.mkdir(editsDir);

      const checkpointPath = getMediaEditCheckpointPath(this.ventureRoot);
      const checkpoint = {
        schemaVersion: 1,
        ventureSlug: this.manifest.slug,
        runId: this.runId,
        skeletal: true,
        enabled: this.manifest.mediaEdit?.enabled === true,
        engine: this.manifest.mediaEdit?.engine ?? "opencut",
        createdAt: nowIso,
      };
      await this.fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
      this.log("info", "media-edit: checkpoint written", { path: checkpointPath });

      indexEntries.push(this.indexEntry(`media-edit-checkpoint-${this.runId}`, "media-edit-checkpoint", checkpointPath, nowIso));
      artifactPaths.push(checkpointPath);
      await this.appendArtifactIndex(indexEntries);

      return {
        success: true,
        stageName: "MEDIA_EDIT",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", "MEDIA_EDIT stage failed", { message });
      return {
        success: false,
        stageName: "MEDIA_EDIT",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: "MEDIA_EDIT_SKELETAL_FAILURE", message, recoverable: true },
      };
    } finally {
      await this.flushLogs();
    }
  }

  // -------------------------------------------------------------------
  // Real path -- 3 steps + checkpoint
  // -------------------------------------------------------------------
  private async runReal(
    requiresReview: boolean,
    provider: MediaEditProvider,
  ): Promise<StageRunResult> {
    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = this.now().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let pending = false;

    try {
      await this.fs.mkdir(getMediaEditDir(this.ventureRoot));
      const exportTargetPath = getEditedReelPath(this.ventureRoot);

      // Step 1: workspace.
      const baseCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
      };
      const ws = await createOpencutWorkspaceStep({
        ...baseCtx,
        provider,
        exportTargetPath,
      });
      if (ws.status === "failed") {
        failureCode = "MEDIA_EDIT_NO_UPSTREAM";
        failureMessage = ws.reason;
        this.log("error", "media-edit: workspace failed", { reason: ws.reason });
        return this.buildFailure(failureCode, failureMessage, artifactPaths);
      }
      if (ws.status === "skipped") {
        this.log("info", "media-edit: workspace skipped", { reason: ws.reason });
        return await this.writeCheckpointAndReturn(
          indexEntries,
          artifactPaths,
          nowIso,
          requiresReview,
          undefined,
        );
      }
      this.log("info", "media-edit: workspace prepared", {
        manifestPath: ws.manifestPath,
        shotCount: ws.shotCount,
        exportTargetPath: ws.exportTargetPath,
      });
      indexEntries.push(this.indexEntry(`media-edit-manifest-${this.runId}`, "clip-manifest", ws.manifestPath, nowIso));
      artifactPaths.push(ws.manifestPath);

      // Step 2: launch.
      const launch = await launchOpencutStep({
        ...baseCtx,
        provider,
        manifestPath: ws.manifestPath,
      });
      if (launch.status === "failed") {
        failureCode = "MEDIA_EDIT_LAUNCH_FAILED";
        failureMessage = launch.error;
        this.log("error", "media-edit: launch failed", { error: launch.error });
        return this.buildFailure(failureCode, failureMessage, artifactPaths);
      }
      if (launch.status === "skipped") {
        this.log("info", "media-edit: launch skipped", { reason: launch.reason });
      } else {
        this.log("info", "media-edit: editor launched", {
          serverUrl: launch.serverUrl,
          serverPort: launch.serverPort,
          pid: launch.pid,
          openedBrowser: launch.openedBrowser,
        });
      }

      // Step 3: await export.
      const awaitCtx: Parameters<typeof awaitOpencutExportStep>[0] = {
        ...baseCtx,
        provider,
        expectedPath: exportTargetPath,
      };
      if (this.awaitTimeoutMs !== undefined) awaitCtx.timeoutMs = this.awaitTimeoutMs;
      if (this.signal !== undefined) awaitCtx.signal = this.signal;
      const awaited = await awaitOpencutExportStep(awaitCtx);

      if (awaited.status === "timeout") {
        pending = true;
        this.log("warn", "media-edit: export timeout", { error: awaited.error });
        const gate = this.buildReviewGate(artifactPaths, "timeout");
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
      } else if (awaited.status === "aborted") {
        pending = true;
        this.log("warn", "media-edit: export aborted", { error: awaited.error });
      } else if (awaited.status === "failed") {
        failureCode = "MEDIA_EDIT_STEP_THREW";
        failureMessage = awaited.error;
        this.log("error", "media-edit: export failed", { error: awaited.error });
        return this.buildFailure(failureCode, failureMessage, artifactPaths);
      } else {
        this.log("info", "media-edit: export detected", {
          reelPath: awaited.reelPath,
          receiptPath: awaited.receiptPath,
          durationSec: awaited.durationSec,
        });
        indexEntries.push(this.indexEntry(`media-edit-receipt-${this.runId}`, "edit-receipt", awaited.receiptPath, nowIso));
        artifactPaths.push(awaited.receiptPath, awaited.reelPath);
        this.log("info", "media-edit: receipt written", {
          path: awaited.receiptPath,
        });
      }

      return await this.writeCheckpointAndReturn(
        indexEntries,
        artifactPaths,
        nowIso,
        requiresReview,
        reviewGateId,
        pending,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "MEDIA_EDIT_STEP_THREW";
      this.log("error", "MEDIA_EDIT stage threw", { code: failureCode, error: message });
      return this.buildFailure(failureCode, failureMessage, artifactPaths);
    } finally {
      // Best-effort teardown of long-running provider resources.
      if (provider.teardown) {
        try {
          await provider.teardown();
        } catch {
          // ignore teardown errors -- run is done
        }
      }
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for MEDIA_EDIT ${this.runId}: ${m}`);
      }
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  private async writeCheckpointAndReturn(
    indexEntries: ArtifactIndexEntry[],
    artifactPaths: string[],
    nowIso: string,
    requiresReview: boolean,
    reviewGateId: string | undefined,
    pending = false,
  ): Promise<StageRunResult> {
    const checkpointPath = getMediaEditCheckpointPath(this.ventureRoot);
    const checkpoint = {
      schemaVersion: 1,
      ventureSlug: this.manifest.slug,
      runId: this.runId,
      skeletal: false,
      enabled: this.manifest.mediaEdit?.enabled === true,
      engine: this.manifest.mediaEdit?.engine ?? "opencut",
      createdAt: nowIso,
      pending,
    };
    await this.fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    this.log("info", "media-edit: checkpoint written", { path: checkpointPath });
    indexEntries.push(this.indexEntry(`media-edit-checkpoint-${this.runId}`, "media-edit-checkpoint", checkpointPath, nowIso));
    artifactPaths.push(checkpointPath);
    await this.appendArtifactIndex(indexEntries);

    const stageRequiresReview = requiresReview || pending;
    const result: StageRunResult = {
      success: true,
      stageName: "MEDIA_EDIT",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: stageRequiresReview,
      nextStageReady: !pending,
    };
    if (reviewGateId !== undefined) result.reviewGateId = reviewGateId;
    return result;
  }

  private buildFailure(
    code: string,
    message: string,
    artifactPaths: string[],
  ): StageRunResult {
    return {
      success: false,
      stageName: "MEDIA_EDIT",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: false,
      nextStageReady: false,
      error: { code, message, recoverable: true },
    };
  }

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "MEDIA_EDIT",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildReviewGate(artifactPaths: string[], reason: "timeout" | "configured"): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: "media-edit-artifact",
        humanReadableContent: `${reason}: ${p}`,
      })),
    };
  }
}
