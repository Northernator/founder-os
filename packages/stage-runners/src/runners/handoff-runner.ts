/**
 * HandoffStageRunner -- the HANDOFF stage's provider-dispatch runner.
 *
 * Reads `manifest.handoffSource` and routes to one of two pipeline
 * steps:
 *   - "stitch"    -> createStitchPackStep (Google Stitch / v0 / Figma
 *                    Make prompt + config + a normalized handoff-export
 *                    with `prompt` populated, `html` left undefined).
 *   - "codesign"  -> createCodesignPackStep (Open CoDesign-shaped
 *                    parametric output: html + parameters + tokens).
 *
 * Default when manifest.handoffSource is undefined: "codesign". This
 * matches the per-venture setting introduced in slice 6 -- existing
 * manifests without the field run the new provider by default. Users
 * who want the legacy Stitch flow set handoffSource: "stitch" in the
 * manifest.
 *
 * Inputs (both providers):
 *   - BrandBrief at 03_brand/brand-kit/brand-brief.json
 *     (written by BrandStageRunner). validate() checks the file exists.
 *   - manifest.appType -- determines prompt shell hints (Stitch path
 *     only; CoDesign infers from the screens canvas).
 *
 * Idempotent: each step early-returns "skipped" when its marker
 * artifact (Stitch: stitch-prompt.md, CoDesign: handoff-export.json)
 * already exists. Re-runs don't overwrite hand-tuned exports.
 *
 * HANDOFF is NOT in DEFAULT_REVIEW_GATES. When opted in via
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
import { createCodesignPackStep, createStitchPackStep } from "@founder-os/pipeline-runner";
import { getBrandKitDir, getStitchDir } from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type HandoffStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
};

type HandoffSource = "stitch" | "codesign";

export class HandoffStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "HANDOFF";

  constructor(opts: HandoffStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
  }

  /** Resolve which provider runs this venture. Defaults to "codesign". */
  private resolveProvider(): HandoffSource {
    const raw = this.manifest.handoffSource;
    return raw === "stitch" ? "stitch" : "codesign";
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];

    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for handoff stage");
    }
    if (!this.manifest.appType?.trim()) {
      errors.push("manifest.appType is required for handoff stage");
    }

    // Brand brief is a hard prerequisite for both providers -- the
    // export's tokens / prompt are built from the brief's
    // typography/personality/colours.
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
    const provider = this.resolveProvider();
    const requiresReview = this.stageRequiresReview();
    this.log("info", "HANDOFF stage starting", {
      runId: this.runId,
      requiresReview,
      provider,
    });

    const stitchDir = getStitchDir(this.ventureRoot);
    const stitchPromptPath = `${stitchDir}/stitch-prompt.md`;
    const stitchConfigPath = `${stitchDir}/stitch-config.json`;
    const handoffExportPath = `${stitchDir}/handoff-export.json`;
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
      // structural typing is sufficient since the steps accept
      // whatever shape the JSON parses to.
      const brief = JSON.parse(briefRaw);

      if (provider === "stitch") {
        const result = await createStitchPackStep({
          fs: this.fs,
          ventureId: this.manifest.id,
          ventureRoot: this.ventureRoot,
          brief,
          appType: this.manifest.appType,
        });
        // Log message kept exactly as it was -- the desktop helper's
        // deriveSteps() and the log-strings drift test both pattern
        // match on this string.
        this.log("info", "create-stitch-pack finished", {
          status: result.status,
          prompt: stitchPromptPath,
          config: stitchConfigPath,
          handoffExport: handoffExportPath,
        });

        indexEntries.push(
          {
            artifactId: "stitch:prompt",
            stageName: "HANDOFF",
            type: "stitch-prompt",
            path: stitchPromptPath,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          },
          {
            artifactId: "stitch:config",
            stageName: "HANDOFF",
            type: "stitch-config",
            path: stitchConfigPath,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          },
          {
            artifactId: "handoff:export",
            stageName: "HANDOFF",
            type: "handoff-export",
            path: handoffExportPath,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          }
        );
        artifactPaths.push(stitchPromptPath, stitchConfigPath, handoffExportPath);
      } else {
        // CoDesign provider -- writes only handoff-export.json. No
        // separate prompt/config files because CoDesign generates UI
        // directly via parametric output.
        const result = await createCodesignPackStep({
          fs: this.fs,
          ventureId: this.manifest.id,
          ventureRoot: this.ventureRoot,
          brief,
          appType: this.manifest.appType,
        });
        this.log("info", "create-codesign-pack finished", {
          status: result.status,
          handoffExport: handoffExportPath,
        });

        indexEntries.push({
          artifactId: "handoff:export",
          stageName: "HANDOFF",
          type: "handoff-export",
          path: handoffExportPath,
          createdAt: nowIso,
          status: "ready",
          runId: this.runId,
        });
        artifactPaths.push(handoffExportPath);
      }

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(provider, {
          stitchPromptPath,
          stitchConfigPath,
          handoffExportPath,
        });
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      // Error codes are namespaced by provider so forensics stay
      // readable. STITCH_* codes are kept for back-compat with old
      // failed-runs.json entries that were written before slice 5.
      if (provider === "stitch") {
        if (/brand-brief|JSON/i.test(message)) failureCode = "STITCH_BRIEF_LOAD_FAILED";
        else failureCode = "STITCH_STEP_THREW";
      } else {
        if (/brand-brief|JSON/i.test(message)) failureCode = "CODESIGN_BRIEF_LOAD_FAILED";
        else failureCode = "CODESIGN_STEP_THREW";
      }
      this.log("error", "HANDOFF stage threw", { code: failureCode, error: message, provider });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for HANDOFF ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "HANDOFF",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: failureCode,
          // *_BRIEF_LOAD_FAILED is recoverable only after the user
          // fixes/regenerates the brand brief; mark it recoverable=true
          // because retry-after-fix is the path forward (consistent
          // with how other runners treat IO failures).
          message: failureMessage ?? "unknown",
          recoverable: true,
        },
      };
    }

    const stageResult: StageRunResult = {
      success: true,
      stageName: "HANDOFF",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(
    provider: HandoffSource,
    paths: { stitchPromptPath: string; stitchConfigPath: string; handoffExportPath: string }
  ): ReviewGate {
    const artifactsForReview =
      provider === "stitch"
        ? [
            {
              path: paths.stitchPromptPath,
              type: "stitch-prompt",
              humanReadableContent: paths.stitchPromptPath,
            },
            {
              path: paths.stitchConfigPath,
              type: "stitch-config",
              humanReadableContent: paths.stitchConfigPath,
            },
          ]
        : [
            {
              path: paths.handoffExportPath,
              type: "handoff-export",
              humanReadableContent: paths.handoffExportPath,
            },
          ];

    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "design",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview,
    };
  }
}
