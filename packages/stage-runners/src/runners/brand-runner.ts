/**
 * BrandStageRunner -- wraps the brand step chain with the StageRunner
 * contract.
 *
 * The brand stage runs three pipeline steps in sequence:
 *   1. generateNamingCandidatesStep   -> 03_brand/names/scan.json
 *   2. createBrandBriefStep            -> 03_brand/brand-kit/brand-brief.json
 *   3. createLogoPackStep              -> 03_brand/logo/exports/<assets>
 *
 * Why this stage almost always pauses for human review: a name choice
 * is irreversible-ish (domain registration, trademark filing, social
 * handle squat), so the founder needs to approve a candidate before
 * the rest of the pipeline (UK setup, finance, build) treats it as
 * locked. BRAND is in DEFAULT_REVIEW_GATES for that reason.
 *
 * Failure handling: each step is awaited in turn. If any throws, the
 * runner returns success=false with the error code identifying which
 * step blew up. Earlier successful artifacts are still indexed so a
 * retry that re-runs the chain doesn't lose context. createBrandBrief
 * and createLogoPack both no-op on existing files (their internal
 * `if (await fs.exists(...)) return skipped` guards), so a retry is
 * safe.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { Filesystem, NamingLlmCaller } from "@founder-os/pipeline-runner";
import {
  createBrandBriefStep,
  createLogoPackStep,
  generateNamingCandidatesStep,
} from "@founder-os/pipeline-runner";
import { getBrandKitDir, getLogoExportsDir } from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type BrandStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  callLlm: NamingLlmCaller;
  /** Optional founder shortlist / "avoid these" hints, forwarded verbatim. */
  seedHints?: string;
  /** How many naming candidates to ask the LLM for. Default 8 (5-10 prompt). */
  targetCount?: number;
  runId?: string;
};

export class BrandStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "BRAND";
  private readonly callLlm: NamingLlmCaller;
  private readonly seedHints: string | undefined;
  private readonly targetCount: number | undefined;

  constructor(opts: BrandStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.seedHints = opts.seedHints;
    this.targetCount = opts.targetCount;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];

    if (typeof this.callLlm !== "function") {
      missing.push("LLM caller");
    }
    if (!this.manifest.name?.trim()) {
      errors.push("manifest.name is required for brand stage");
    }
    if (!this.manifest.slug?.trim()) {
      errors.push("manifest.slug is required for brand stage");
    }

    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "BRAND stage starting", { runId: this.runId, requiresReview });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      // ----- Step 1: Naming candidates -----
      this.log("info", "generating naming candidates");
      const namingCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        callLlm: this.callLlm,
        ...(this.seedHints !== undefined ? { seedHints: this.seedHints } : {}),
        ...(this.targetCount !== undefined ? { targetCount: this.targetCount } : {}),
      };
      const naming = await generateNamingCandidatesStep(namingCtx);
      this.log("info", "naming step finished", {
        status: naming.status,
        added: naming.added.length,
        total: naming.total,
        note: naming.note,
      });
      indexEntries.push({
        artifactId: "brand:naming-scan",
        stageName: "BRAND",
        type: "brand-naming-scan",
        path: naming.scanPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(naming.scanPath);

      // ----- Step 2: Brand brief -----
      this.log("info", "creating brand brief");
      const briefResult = await createBrandBriefStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
      });
      const briefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
      this.log("info", "brand-brief step finished", {
        status: briefResult.status,
        path: briefPath,
      });
      indexEntries.push({
        artifactId: "brand:brief",
        stageName: "BRAND",
        type: "brand-brief",
        path: briefPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(briefPath);

      // ----- Step 3: Logo pack -----
      this.log("info", "materializing logo pack");
      const logoResult = await createLogoPackStep({
        fs: this.fs,
        ventureId: this.manifest.id,
        ventureRoot: this.ventureRoot,
        brief: briefResult.brief,
      });
      const logoMarker = `${getLogoExportsDir(this.ventureRoot)}/logo.svg`;
      this.log("info", "logo-pack step finished", { status: logoResult.status, path: logoMarker });
      indexEntries.push({
        artifactId: "brand:logo-pack",
        stageName: "BRAND",
        type: "brand-logo-pack",
        path: logoMarker,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(logoMarker);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(naming.scanPath, briefPath, logoMarker);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      // Best-effort label of which step blew up. The error message
      // typically contains the step's logger scope so we pattern-match
      // for a more useful code; otherwise we fall back to a generic.
      if (/naming/i.test(message)) failureCode = "BRAND_NAMING_FAILED";
      else if (/brand-brief|brand brief/i.test(message)) failureCode = "BRAND_BRIEF_FAILED";
      else if (/logo/i.test(message)) failureCode = "BRAND_LOGO_FAILED";
      else failureCode = "BRAND_STEP_THREW";
      this.log("error", "BRAND stage threw", { code: failureCode, error: message });

      // Index whatever did succeed before the throw -- the retry path
      // benefits from knowing partial state exists.
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
        console.warn(`stage-runners: log flush failed for BRAND ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "BRAND",
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
      stageName: "BRAND",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(scanPath: string, briefPath: string, logoMarker: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      // The desktop UI fetches and renders these files when showing the
      // gate. We intentionally don't embed bodies here -- the JSON file
      // stays bounded.
      artifactsForReview: [
        { path: scanPath, type: "brand-naming-scan", humanReadableContent: scanPath },
        { path: briefPath, type: "brand-brief", humanReadableContent: briefPath },
        { path: logoMarker, type: "brand-logo-pack", humanReadableContent: logoMarker },
      ],
    };
  }
}
