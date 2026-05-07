/**
 * BuildStageRunner -- wraps createBuildHandoffStep with the StageRunner contract.
 *
 * The build stage is the cross-process boundary: the orchestrator
 * writes a HandoffBundle to .founder/handoffs/inbox/<bundleRunId>.json
 * and the VS Code extension picks it up async. This runner KICKS OFF
 * the handoff -- it does NOT wait for the extension to process it.
 * That's a separate cross-process concern handled by handoff-watcher
 * + handoff-result ingestion in the desktop, well outside the runner's
 * responsibility.
 *
 * Practical implication: a successful runStage() means "bundle dropped
 * in inbox", not "build complete". The desktop UI surfaces build
 * progress separately via the handoff watcher.
 *
 * Inputs:
 *  - BrandBrief loaded from 03_brand/brand-kit/brand-brief.json
 *  - Stitch pack (preconditions) at 06_product/stitch/
 *  - Product spec (preconditions) at 06_product/specs/product-spec.md
 *  - All checked by validate(); missing prereqs short-circuit the run
 *    with a clear "run HANDOFF stage first" message.
 *
 * BUILD is NOT in DEFAULT_REVIEW_GATES. When opted in, requiredApproval
 * is "security" -- the build is what's about to ship to users.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { Filesystem } from "@founder-os/pipeline-runner";
import { createBuildHandoffStep } from "@founder-os/pipeline-runner";
import {
  getBrandKitDir,
  getHandoffExportPath,
  getHandoffInboxPath,
  getProductSpecMarkdownPath,
  getStitchDir,
} from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type BuildStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
};

export class BuildStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "BUILD";

  constructor(opts: BuildStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];

    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for build stage");
    }

    // Three hard prereqs. The handoff bundle the step writes carries
    // explicit paths to all three; if any is missing the extension
    // would fail downstream anyway. Fail loud here with a clear hint.
    const briefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
    if (!(await this.fs.exists(briefPath))) {
      missing.push(`brand-brief at ${briefPath} -- run BRAND stage first`);
    }
    // Slice 7 of dual-handoff arc: BUILD now requires the normalized
    // handoff-export.json (written by both Stitch and CoDesign
    // providers) instead of the Stitch-only stitch-prompt.md. Missing
    // export means HANDOFF hasn't run yet -- the user picks the
    // provider via manifest.handoffSource and runs HANDOFF, both of
    // which now produce handoff-export.json.
    const handoffExportPath = getHandoffExportPath(this.ventureRoot);
    if (!(await this.fs.exists(handoffExportPath))) {
      missing.push(
        `handoff export at ${handoffExportPath} -- run HANDOFF stage first`
      );
    }
    const specPath = getProductSpecMarkdownPath(this.ventureRoot);
    if (!(await this.fs.exists(specPath))) {
      missing.push(`product spec at ${specPath} -- run PRODUCT_SPEC stage first`);
    }

    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "BUILD stage starting", { runId: this.runId, requiresReview });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let bundlePath: string | undefined;

    try {
      // Load brand brief. Same approach as StitchStageRunner --
      // structural typing instead of importing branding-core.
      const briefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
      const brief = JSON.parse(await this.fs.readFile(briefPath));

      const result = await createBuildHandoffStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        brief,
      });

      // The bundle file is named after the bundle's own runId (an
      // independent identifier from this runner's runId). Reconstruct
      // the path so we can index it.
      bundlePath = `${getHandoffInboxPath(this.ventureRoot)}/${result.bundle.runId}.json`;
      this.log("info", "create-build-handoff finished", {
        status: result.status,
        bundleRunId: result.bundle.runId,
        bundleType: result.bundle.type,
        bundlePath,
      });

      indexEntries.push({
        artifactId: `build:handoff-${result.bundle.runId}`,
        stageName: "BUILD",
        type: "build-handoff-bundle",
        path: bundlePath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(bundlePath);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(bundlePath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      if (/brand-brief|JSON/i.test(message)) failureCode = "BUILD_BRIEF_LOAD_FAILED";
      else failureCode = "BUILD_STEP_THREW";
      this.log("error", "BUILD stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for BUILD ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "BUILD",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: failureCode,
          message: failureMessage ?? "unknown",
          recoverable: true,
        },
      };
    }

    const stageResult: StageRunResult = {
      success: true,
      stageName: "BUILD",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(bundlePath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      // The build is what gets shipped to users -- security is the
      // right approval lens. (Compared to BRAND = business and
      // PRODUCT_SPEC = design.)
      requiredApproval: "security",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        {
          path: bundlePath,
          type: "build-handoff-bundle",
          humanReadableContent: bundlePath,
        },
      ],
    };
  }
}
