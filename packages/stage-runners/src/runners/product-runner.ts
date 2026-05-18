/**
 * ProductStageRunner -- wraps the deterministic product step chain.
 *
 * The product stage runs three pipeline steps in sequence:
 *   1. ensureBriefStep    -> 06_product/brief/dev-brief.md
 *   2. ensureSpecStep     -> 06_product/specs/spec-canvas.json + product-spec.md
 *   3. ensureScreensStep  -> 06_product/wireframes/screens-canvas.json + screens.md
 *
 * All three are deterministic (no LLM call). They are idempotent --
 * each one early-returns "skipped" if its target file already exists.
 * That makes the whole stage safely re-runnable: a failed mid-chain
 * run can be retried and previously-generated artifacts won't be
 * clobbered.
 *
 * PRODUCT_SPEC is NOT in DEFAULT_REVIEW_GATES (defaults are BRAND +
 * AUDIT) so most ventures advance through this stage without pausing
 * for human review. Founders who want to lock the spec before
 * downstream stages can opt in via venture.yaml's
 * pipeline.reviewGates list.
 *
 * Future work: a future slice may add an LLM-driven spec authoring
 * step (e.g. asking Claude to fill in a richer spec from the brief).
 * That would slot in between ensureBrief and ensureSpec without
 * changing the runner's external contract.
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
import { ensureBriefStep, ensureScreensStep, ensureSpecStep } from "@founder-os/pipeline-runner";
import {
  getBriefDir,
  getProductSpecMarkdownPath,
  getScreensCanvasPath,
  getScreensMarkdownPath,
  getSpecCanvasPath,
} from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type ProductStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
};

export class ProductStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "PRODUCT_SPEC";

  constructor(opts: ProductStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!this.manifest.name?.trim()) {
      errors.push("manifest.name is required for product stage");
    }
    if (!this.manifest.appType?.trim()) {
      errors.push("manifest.appType is required for product stage");
    }
    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for product stage");
    }

    return {
      valid: errors.length === 0,
      missingResources: [],
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "PRODUCT_SPEC stage starting", {
      runId: this.runId,
      requiresReview,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      // ----- Step 1: dev-brief.md -----
      this.log("info", "ensuring dev brief");
      const briefResult = await ensureBriefStep({
        fs: this.fs,
        ventureId: this.manifest.id,
        ventureRoot: this.ventureRoot,
        ventureName: this.manifest.name,
        appType: this.manifest.appType,
        ...(this.manifest.industry !== undefined ? { industry: this.manifest.industry } : {}),
      });
      const briefPath = `${getBriefDir(this.ventureRoot)}/dev-brief.md`;
      this.log("info", "ensure-brief finished", {
        status: briefResult.status,
        path: briefPath,
      });
      indexEntries.push({
        artifactId: "product:dev-brief",
        stageName: "PRODUCT_SPEC",
        type: "product-dev-brief",
        path: briefPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(briefPath);

      // ----- Step 2: spec canvas + markdown -----
      this.log("info", "ensuring spec canvas");
      const specResult = await ensureSpecStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
      });
      const specCanvasPath = getSpecCanvasPath(this.ventureRoot);
      const specMdPath = getProductSpecMarkdownPath(this.ventureRoot);
      this.log("info", "ensure-spec finished", {
        status: specResult.status,
        canvas: specCanvasPath,
        markdown: specMdPath,
      });
      indexEntries.push({
        artifactId: "product:spec-canvas",
        stageName: "PRODUCT_SPEC",
        type: "product-spec-canvas",
        path: specCanvasPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "product:spec-markdown",
        stageName: "PRODUCT_SPEC",
        type: "product-spec-markdown",
        path: specMdPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(specCanvasPath, specMdPath);

      // ----- Step 3: screens canvas + markdown -----
      this.log("info", "ensuring screens canvas");
      const screensResult = await ensureScreensStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
      });
      const screensCanvasPath = getScreensCanvasPath(this.ventureRoot);
      const screensMdPath = getScreensMarkdownPath(this.ventureRoot);
      this.log("info", "ensure-screens finished", {
        status: screensResult.status,
        canvas: screensCanvasPath,
        markdown: screensMdPath,
      });
      indexEntries.push({
        artifactId: "product:screens-canvas",
        stageName: "PRODUCT_SPEC",
        type: "product-screens-canvas",
        path: screensCanvasPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "product:screens-markdown",
        stageName: "PRODUCT_SPEC",
        type: "product-screens-markdown",
        path: screensMdPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(screensCanvasPath, screensMdPath);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(briefPath, specCanvasPath, screensCanvasPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      // Best-effort label of which step blew up. The error message
      // typically contains the step's logger scope so we pattern-match
      // for a more useful code; otherwise we fall back to a generic.
      if (/ensure-brief|dev[- ]brief/i.test(message)) failureCode = "PRODUCT_BRIEF_FAILED";
      else if (/ensure-spec|spec[- ]canvas/i.test(message)) failureCode = "PRODUCT_SPEC_FAILED";
      else if (/ensure-screens|screens[- ]canvas/i.test(message))
        failureCode = "PRODUCT_SCREENS_FAILED";
      else failureCode = "PRODUCT_STEP_THREW";
      this.log("error", "PRODUCT_SPEC stage threw", { code: failureCode, error: message });

      // Index whatever did succeed before the throw -- the retry path
      // benefits from knowing partial state exists. Each underlying
      // step early-returns "skipped" on existing files so a retry
      // cleanly resumes from the failure point.
      if (indexEntries.length > 0) {
        try {
          await this.appendArtifactIndex(indexEntries);
        } catch (indexErr) {
          const im = indexErr instanceof Error ? indexErr.message : String(indexErr);
          this.log("warn", "partial artifact index write failed", { error: im });
        }
      }
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for PRODUCT_SPEC ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "PRODUCT_SPEC",
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
      stageName: "PRODUCT_SPEC",
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
    briefPath: string,
    specCanvasPath: string,
    screensCanvasPath: string
  ): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "design",
      status: "pending",
      createdAt: new Date().toISOString(),
      // The desktop UI fetches and renders these files when showing
      // the gate. Bodies stay on disk so the JSON file is bounded.
      artifactsForReview: [
        { path: briefPath, type: "product-dev-brief", humanReadableContent: briefPath },
        {
          path: specCanvasPath,
          type: "product-spec-canvas",
          humanReadableContent: specCanvasPath,
        },
        {
          path: screensCanvasPath,
          type: "product-screens-canvas",
          humanReadableContent: screensCanvasPath,
        },
      ],
    };
  }
}
