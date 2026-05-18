/**
 * BuildStageRunner -- wraps createBuildHandoffStep + createBuildBackendStep
 * with the StageRunner contract.
 *
 * The build stage is the cross-process boundary: the orchestrator
 * writes one or two HandoffBundles to .founder/handoffs/inbox/<bundleRunId>.json
 * and the VS Code extension picks them up async. This runner KICKS OFF
 * the handoffs -- it does NOT wait for the extension to process them.
 * That's a separate cross-process concern handled by handoff-watcher
 * + handoff-result ingestion in the desktop, well outside the runner's
 * responsibility.
 *
 * Practical implication: a successful runStage() means "bundle(s) dropped
 * in inbox", not "build complete". The desktop UI surfaces build
 * progress separately via the handoff watcher.
 *
 * Inputs:
 *  - BrandBrief loaded from 03_brand/brand-kit/brand-brief.json
 *  - Stitch pack (preconditions) at 06_product/stitch/
 *  - Product spec (preconditions) at 06_product/specs/product-spec.md
 *  - HandoffExport (slice 7 of dual-handoff arc) at
 *    .founder/handoffs/handoff-export.json
 *  - BackendExport (slice 6 of backend arc, OPTIONAL) at
 *    12_backend/backend-export.json. When present, an additional
 *    BUILD_FROM_BACKEND_EXPORT bundle ships in the same inbox.
 *  - All hard prereqs checked by validate(); missing required prereqs
 *    short-circuit the run with a clear "run X stage first" message.
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
import {
  createBuildBackendStep,
  createBuildHandoffStep,
} from "@founder-os/pipeline-runner";
import {
  getBrandKitDir,
  getHandoffExportPath,
  getHandoffInboxPath,
  getProductSpecMarkdownPath,
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
        `handoff export at ${handoffExportPath} -- run HANDOFF stage first`,
      );
    }
    const specPath = getProductSpecMarkdownPath(this.ventureRoot);
    if (!(await this.fs.exists(specPath))) {
      missing.push(`product spec at ${specPath} -- run PRODUCT_SPEC stage first`);
    }

    // backend-export.json is SOFT-required (slice 6 of backend arc).
    // Missing it just means createBuildBackendStep returns "skipped" --
    // BUILD still produces the frontend handoff bundle. This keeps
    // backend-less ventures (marketing sites, pure-frontend extensions)
    // able to BUILD without first running BACKEND. The runner emits a
    // log line in run() noting whether the backend bundle landed.
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

      // Step 1: frontend handoff bundle. Hard requirement -- handoff
      // export was validated above, so this should always succeed
      // (createBuildHandoffStep has its own permissive fallback to
      // BUILD_FROM_BRIEF if the export got corrupted between
      // validate and run).
      const handoffResult = await createBuildHandoffStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        brief,
      });
      // The bundle file is named after the bundle's own runId (an
      // independent identifier from this runner's runId). Reconstruct
      // the path so we can index it.
      bundlePath = `${getHandoffInboxPath(this.ventureRoot)}/${handoffResult.bundle.runId}.json`;
      this.log("info", "create-build-handoff finished", {
        status: handoffResult.status,
        bundleRunId: handoffResult.bundle.runId,
        bundleType: handoffResult.bundle.type,
        bundlePath,
      });
      indexEntries.push({
        artifactId: `build:handoff-${handoffResult.bundle.runId}`,
        stageName: "BUILD",
        type: "build-handoff-bundle",
        path: bundlePath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(bundlePath);

      // Step 2: backend bundle (slice 6 of backend arc). Soft-required
      // -- when backend-export.json is missing or unparseable the step
      // returns "skipped" and we emit only the handoff bundle.
      const backendResult = await createBuildBackendStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
      });
      if (backendResult.status === "done") {
        this.log("info", "create-build-backend finished", {
          status: backendResult.status,
          bundleRunId: backendResult.bundle.runId,
          bundleType: backendResult.bundle.type,
          bundlePath: backendResult.bundlePath,
          engine: backendResult.backendExport.engine,
          collectionCount: backendResult.backendExport.collections.length,
          sdkImportPath: backendResult.backendExport.sdk.importPath,
        });
        indexEntries.push({
          artifactId: `build:backend-${backendResult.bundle.runId}`,
          stageName: "BUILD",
          type: "build-backend-bundle",
          path: backendResult.bundlePath,
          createdAt: nowIso,
          status: "ready",
          runId: this.runId,
        });
        artifactPaths.push(backendResult.bundlePath);
      } else {
        this.log("info", "create-build-backend skipped", {
          reason: backendResult.reason,
          backendExportPath: backendResult.backendExportPath,
        });
      }

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(artifactPaths);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
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

  private buildReviewGate(bundlePaths: string[]): ReviewGate {
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
      artifactsForReview: bundlePaths.map((p) => ({
        path: p,
        type: p.endsWith(".json")
          ? p.includes("/inbox/")
            ? "build-handoff-bundle"
            : "build-artifact"
          : "build-artifact",
        humanReadableContent: p,
      })),
    };
  }
}
