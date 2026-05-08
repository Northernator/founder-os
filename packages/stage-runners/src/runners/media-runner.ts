/**
 * MediaStageRunner -- promoted from skeletal to real (slice 4 of media arc).
 *
 * Orchestrates four pipeline-runner steps under one StageRunner contract:
 *
 *   1. createMediaScriptStep    -- launch-announcement.md + brand brief
 *                                  -> MediaScript JSON + markdown.
 *                                  LLM-aware via optional callLlm
 *                                  (subscription-mode CLIs preferred per
 *                                  project policy).
 *   2. createStoryboardStep     -- MediaScript -> Storyboard with engine
 *                                  hints. Pure deterministic shaping.
 *   3. createRenderShotsStep    -- per-shot dispatch to providers (slice 4
 *                                  ships HyperFrames; later slices add
 *                                  Wan2/CogVideoX/Gemini-API). gemini_flow
 *                                  paste-in path writes flow-prompts.md
 *                                  and triggers a review-gate pause.
 *   4. createStitchStep         -- ffmpeg-concats per-shot MP4s into
 *                                  exports/launch-reel.mp4. Skipped when
 *                                  step 3 reported pending-flow.
 *
 * Behaviour
 * ---------
 *  - validate() requires manifest.id + name. Upstream artifacts (launch
 *    announcement, brand brief) are read best-effort by the steps; their
 *    absence degrades gracefully.
 *  - Indexed artifacts on success: media-script.json + .md, storyboard.json,
 *    flow-prompts.md (if pending), launch-reel.mp4 (if stitched).
 *  - Drift-protected log strings: "MEDIA stage starting", "media script
 *    written", "storyboard written", "render-shots finished" (with
 *    success/failed/pending counts), "launch reel stitched". A future
 *    run-media-stage.ts:deriveSteps + log-strings.test.ts pin them.
 *  - Pending-flow short-circuits the runner: review gate is required on
 *    the flow-prompts.md artifact, nextStageReady=false, founder pastes
 *    Flow output into renders/ and re-runs to advance.
 *  - MEDIA is NOT in DEFAULT_REVIEW_GATES. Opt in via pipeline.reviewGates
 *    -> requiredApproval = "business" (launch-reel content is a brand
 *    decision, not legal/security/design).
 *
 * Idempotent: each run regenerates everything from upstream state.
 * Re-running is safe and expected after a Flow paste-in.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { MediaProvider } from "@founder-os/media-core";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import {
  createMediaScriptStep,
  createRenderShotsStep,
  createStitchStep,
  createStoryboardStep,
} from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type MediaStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional SaaS LLM caller. Subscription-mode CLIs (Claude CLI /
   * Gemini CLI) are preferred per project policy -- callers
   * constructed via apps/founder-desktop's buildPipelineLlmCaller
   * already route there when available. When omitted, the script
   * step renders a deterministic templated narrative; the structural
   * JSON shape is identical either way.
   */
  callLlm?: SaasLlmCaller;
  /**
   * MediaProviders the runner can dispatch to. Slice 4 ships
   * HyperFrames; the desktop app builds it via
   * createHyperframesProvider() and passes it in. Empty array =
   * every shot falls through to the gemini_flow paste-in path.
   */
  providers?: ReadonlyArray<MediaProvider>;
  runId?: string;
};

export class MediaStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "MEDIA";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly providers: ReadonlyArray<MediaProvider>;

  constructor(opts: MediaStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.providers = opts.providers ?? [];
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for media stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for media stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "MEDIA stage starting", {
      runId: this.runId,
      requiresReview,
      withLlm: this.callLlm !== undefined,
      providerCount: this.providers.length,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let pendingFlow = false;

    try {
      // Step 1: media script.
      const baseCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
      };
      const scriptCtx = {
        ...baseCtx,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
      };
      const scriptResult = await createMediaScriptStep(scriptCtx);
      this.log("info", "media script written", {
        path: scriptResult.jsonPath,
        sceneCount: scriptResult.script.scenes.length,
        generationSource: scriptResult.generationSource,
        sources: scriptResult.sources,
      });
      indexEntries.push(this.indexEntry("media:script-json", "media-script", scriptResult.jsonPath, nowIso));
      indexEntries.push(this.indexEntry("media:script-md", "media-script-markdown", scriptResult.mdPath, nowIso));
      artifactPaths.push(scriptResult.jsonPath, scriptResult.mdPath);

      // Step 2: storyboard.
      const storyboardResult = await createStoryboardStep({
        ...baseCtx,
        script: scriptResult.script,
      });
      this.log("info", "storyboard written", {
        path: storyboardResult.jsonPath,
        shotCount: storyboardResult.shotCount,
      });
      indexEntries.push(this.indexEntry("media:storyboard", "storyboard", storyboardResult.jsonPath, nowIso));
      artifactPaths.push(storyboardResult.jsonPath);

      // Step 3: render shots.
      const renderResult = await createRenderShotsStep({
        ...baseCtx,
        storyboard: storyboardResult.storyboard,
        providers: this.providers,
      });
      this.log("info", "render-shots finished", {
        rendersDir: renderResult.rendersDir,
        shotCount: renderResult.shotCount,
        success: renderResult.successCount,
        failures: renderResult.failureCount,
        pendingFlow: renderResult.pendingFlowCount,
        status: renderResult.status,
      });
      if (renderResult.flowPromptsPath) {
        indexEntries.push(
          this.indexEntry("media:flow-prompts", "media-flow-prompts", renderResult.flowPromptsPath, nowIso),
        );
        artifactPaths.push(renderResult.flowPromptsPath);
      }
      for (const r of renderResult.perShotResults) {
        if (r.status === "rendered") {
          indexEntries.push(
            this.indexEntry(`media:render-${r.sceneId}`, "media-render", r.path, nowIso),
          );
          artifactPaths.push(r.path);
        }
      }
      pendingFlow = renderResult.status === "pending-flow";

      // Step 4: stitch (only when render was clean).
      if (!pendingFlow && renderResult.failureCount === 0) {
        const renderedPaths = renderResult.perShotResults
          .filter((r): r is Extract<typeof r, { status: "rendered" }> => r.status === "rendered")
          .map((r) => r.path);
        const stitchResult = await createStitchStep({
          ...baseCtx,
          shotPaths: renderedPaths,
        });
        if (stitchResult.status === "done" && stitchResult.reelPath) {
          this.log("info", "launch reel stitched", {
            path: stitchResult.reelPath,
            shotCount: stitchResult.shotCount,
          });
          indexEntries.push(
            this.indexEntry("media:launch-reel", "launch-reel", stitchResult.reelPath, nowIso),
          );
          artifactPaths.push(stitchResult.reelPath);
        } else {
          this.log("warn", "launch reel skipped", {
            reason: stitchResult.reason ?? "unknown",
          });
        }
      }

      await this.appendArtifactIndex(indexEntries);

      // Pending-flow forces a review gate regardless of pipeline.reviewGates --
      // the founder MUST paste Flow output before MEDIA can advance.
      const needsGate = requiresReview || pendingFlow;
      if (needsGate) {
        const gate = this.buildReviewGate(artifactPaths, pendingFlow);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", {
          gateId: reviewGateId,
          reason: pendingFlow ? "pending-flow paste-in" : "configured review gate",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "MEDIA_STEP_THREW";
      this.log("error", "MEDIA stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for MEDIA ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "MEDIA",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: failureCode, message: failureMessage ?? "unknown", recoverable: true },
      };
    }

    const stageRequiresReview = requiresReview || pendingFlow;
    const stageResult: StageRunResult = {
      success: true,
      stageName: "MEDIA",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: stageRequiresReview,
      nextStageReady: !stageRequiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "MEDIA",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildReviewGate(artifactPaths: string[], pendingFlow: boolean): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: pendingFlow && p.endsWith("flow-prompts.md") ? "media-flow-prompts" : "media-artifact",
        humanReadableContent: p,
      })),
    };
  }
}
