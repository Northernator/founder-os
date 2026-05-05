/**
 * LaunchStageRunner -- wraps createLaunchPackageStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - validate() requires manifest.id and manifest.name. The step
 *    itself is tolerant of missing upstream artifacts -- they all
 *    degrade to defaults and surface as warnings/fails on the
 *    pre-launch checklist.
 *  - run() always invokes createLaunchPackageStep. The step:
 *      1. reads brand brief / validation summary / finance plan /
 *         UK setup canvas / build handoff (best-effort);
 *      2. builds a pre-launch checklist;
 *      3. always writes 08_launch/launch-receipt.json +
 *         launch-announcement.md.
 *  - When `callLlm` is provided the step LLM-writes the announcement
 *    markdown. Without it a deterministic templated announcement.
 *  - Indexes BOTH artifacts.
 *  - Emits a "launch receipt written" log message on success -- log
 *    string kept verbatim for run-launch-stage.ts:deriveSteps and
 *    log-strings.test.ts.
 *
 * LAUNCH is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "business" -- a
 * "we are now live" decision is a business call.
 *
 * Idempotent: each run regenerates both files from the latest
 * upstream state. Safe to re-run after a rollback or post-launch
 * update.
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
import { createLaunchPackageStep } from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type LaunchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-writes the
   * announcement; otherwise a deterministic templated announcement
   * is rendered.
   */
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export class LaunchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "LAUNCH";
  private readonly callLlm: SaasLlmCaller | undefined;

  constructor(opts: LaunchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for launch stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for launch stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "LAUNCH stage starting", {
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
      const result = await createLaunchPackageStep(stepCtx);

      // Drift-protected log message: run-launch-stage.ts:deriveSteps
      // matches this string exactly, and log-strings.test.ts asserts it.
      // Don't change without updating both.
      this.log("info", "launch receipt written", {
        path: result.receiptPath,
        receiptStatus: result.receipt.status,
        generationSource: result.receipt.generationSource,
        sources: result.receipt.sources,
      });

      indexEntries.push({
        artifactId: "launch:receipt",
        stageName: "LAUNCH",
        type: "launch-receipt",
        path: result.receiptPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "launch:announcement",
        stageName: "LAUNCH",
        type: "launch-announcement",
        path: result.announcementPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(result.receiptPath, result.announcementPath);
      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(result.receiptPath, result.announcementPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "LAUNCH_STEP_THREW";
      this.log("error", "LAUNCH stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for LAUNCH ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "LAUNCH",
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
      stageName: "LAUNCH",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(receiptPath: string, announcementPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: receiptPath, type: "launch-receipt", humanReadableContent: receiptPath },
        {
          path: announcementPath,
          type: "launch-announcement",
          humanReadableContent: announcementPath,
        },
      ],
    };
  }
}
