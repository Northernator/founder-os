/**
 * StitchStageRunner -- wraps createStitchPackStep with the StageRunner contract.
 *
 * The stitch stage produces a stitch-prompt.md (and adjacent
 * stitch-config.json) under 06_product/stitch/. The pack is the
 * handoff to design-AI tooling: the prompt is what gets pasted into
 * Stitch / v0 / Figma Make to generate screens, the config carries the
 * structured data those tools need.
 *
 * Inputs:
 *   - BrandBrief loaded from 03_brand/brand-kit/brand-brief.json
 *     (written by BrandStageRunner). validate() checks the file exists.
 *   - manifest.appType (web/saas/mobile/etc) -- determines the prompt
 *     shell hints.
 *
 * Idempotent: createStitchPackStep early-returns "skipped" if
 * stitch-prompt.md exists. Retry safe.
 *
 * STITCH is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the gate's requiredApproval is "design"
 * (matches PRODUCT_SPEC -- both are design-shaped artifacts).
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
import { createStitchPackStep } from "@founder-os/pipeline-runner";
import { getBrandKitDir, getStitchDir } from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type StitchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
};

export class StitchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "STITCH";

  constructor(opts: StitchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];

    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for stitch stage");
    }
    if (!this.manifest.appType?.trim()) {
      errors.push("manifest.appType is required for stitch stage");
    }

    // Brand brief is a hard prerequisite -- the stitch pack is built
    // from the brief's typography/personality/colours.
    const briefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
    if (!(await this.fs.exists(briefPath))) {
      missing.push(`brand-brief at ${briefPath} -- run BRAND stage first`);
    }

    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "STITCH stage starting", { runId: this.runId, requiresReview });

    const stitchDir = getStitchDir(this.ventureRoot);
    const stitchPromptPath = `${stitchDir}/stitch-prompt.md`;
    const stitchConfigPath = `${stitchDir}/stitch-config.json`;
    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      // Load brand brief from disk. validate() checked it exists; if
      // it's malformed we treat that as an unrecoverable run error.
      const briefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
      const briefRaw = await this.fs.readFile(briefPath);
      // BrandBrief comes from @founder-os/branding-core. We avoid
      // importing it directly to keep stage-runners dep-light;
      // structural typing is sufficient since the step accepts
      // whatever shape the JSON parses to. The step itself doesn't
      // re-validate -- a malformed brief surfaces as a step error.
      const brief = JSON.parse(briefRaw);

      const result = await createStitchPackStep({
        fs: this.fs,
        ventureId: this.manifest.id,
        ventureRoot: this.ventureRoot,
        brief,
        appType: this.manifest.appType,
      });
      this.log("info", "create-stitch-pack finished", {
        status: result.status,
        prompt: stitchPromptPath,
        config: stitchConfigPath,
      });

      indexEntries.push({
        artifactId: "stitch:prompt",
        stageName: "STITCH",
        type: "stitch-prompt",
        path: stitchPromptPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "stitch:config",
        stageName: "STITCH",
        type: "stitch-config",
        path: stitchConfigPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(stitchPromptPath, stitchConfigPath);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(stitchPromptPath, stitchConfigPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      if (/brand-brief|JSON/i.test(message)) failureCode = "STITCH_BRIEF_LOAD_FAILED";
      else failureCode = "STITCH_STEP_THREW";
      this.log("error", "STITCH stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for STITCH ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "STITCH",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: failureCode,
          // STITCH_BRIEF_LOAD_FAILED is recoverable only after the
          // user fixes/regenerates the brand brief; we mark it
          // recoverable=true because retry-after-fix is the path
          // forward (consistent with how other runners treat IO
          // failures).
          message: failureMessage ?? "unknown",
          recoverable: true,
        },
      };
    }

    const stageResult: StageRunResult = {
      success: true,
      stageName: "STITCH",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(promptPath: string, configPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "design",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: promptPath, type: "stitch-prompt", humanReadableContent: promptPath },
        { path: configPath, type: "stitch-config", humanReadableContent: configPath },
      ],
    };
  }
}
