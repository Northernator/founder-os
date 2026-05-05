/**
 * WireframeStageRunner -- wraps createWireframesStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - validate() requires manifest.id + the screens canvas at
 *    06_product/wireframes/screens-canvas.json. The canvas is
 *    produced by ProductStageRunner via ensureScreensStep; if missing,
 *    the orchestrator routes through interpret() and surfaces the
 *    "run PRODUCT_SPEC stage first" message in the FailedRunBanner.
 *  - run() always invokes createWireframesStep (the runner has no
 *    "skeletal placeholder" path anymore -- the step itself produces
 *    a useful wireframe checkpoint even when the canvas is empty).
 *  - When `callLlm` is provided the step LLM-enriches each screen\'s
 *    "Layout & states" narrative; without it the step renders a
 *    deterministic templated narrative keyed off the shellType.
 *  - Indexes BOTH wireframe-checkpoint.json AND wireframes.md on
 *    the artifact index. The .json is the machine-readable contract;
 *    the .md is what designers and the founder review.
 *  - Emits a "wireframe checkpoint written" log on success. The log
 *    string is parsed by the desktop helper run-wireframe-stage.ts
 *    (deriveSteps) and pinned by the log-strings drift-vitest.
 *
 * WIREFRAME is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "design".
 *
 * Idempotent: the step always overwrites both summary files with
 * the latest screens-canvas state. The screens canvas is never
 * touched.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import { createWireframesStep } from "@founder-os/pipeline-runner";
import { getScreensCanvasPath } from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type WireframeStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-enriches per-
   * screen narratives. When omitted, deterministic templated
   * narratives are used. Either path is supported; the runner does
   * not require an LLM caller in validate().
   */
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export class WireframeStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "WIREFRAME";
  private readonly callLlm: SaasLlmCaller | undefined;

  constructor(opts: WireframeStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for wireframe stage");
    const screensPath = getScreensCanvasPath(this.ventureRoot);
    if (!(await this.fs.exists(screensPath))) {
      missing.push(`screens canvas at ${screensPath} (run PRODUCT_SPEC stage first)`);
    }
    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "WIREFRAME stage starting", {
      runId: this.runId,
      requiresReview,
      withLlm: this.callLlm !== undefined,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      const stepCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
      };
      const result = await createWireframesStep(stepCtx);

      // Drift-protected log message: run-wireframe-stage.ts:deriveSteps
      // matches this string exactly, and log-strings.test.ts asserts it.
      // Don't change this without updating both.
      this.log("info", "wireframe checkpoint written", {
        path: result.jsonPath,
        totalScreens: result.checkpoint.summary.totalScreens,
        generationSource: result.checkpoint.generationSource,
        sources: result.checkpoint.sources,
      });

      indexEntries.push({
        artifactId: "wireframe:checkpoint",
        stageName: "WIREFRAME",
        type: "wireframe-checkpoint",
        path: result.jsonPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "wireframe:markdown",
        stageName: "WIREFRAME",
        type: "wireframe-markdown",
        path: result.mdPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(result.jsonPath, result.mdPath);
      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(result.jsonPath, result.mdPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "WIREFRAME_STEP_THREW";
      this.log("error", "WIREFRAME stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for WIREFRAME ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "WIREFRAME",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: failureCode, message: failureMessage ?? "unknown", recoverable: true },
      };
    }

    const stageResult: StageRunResult = {
      success: true,
      stageName: "WIREFRAME",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(jsonPath: string, mdPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "design",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: jsonPath, type: "wireframe-checkpoint", humanReadableContent: jsonPath },
        { path: mdPath, type: "wireframe-markdown", humanReadableContent: mdPath },
      ],
    };
  }
}
