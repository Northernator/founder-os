/**
 * ResearchStageRunner -- wraps createSaasResearchReportsStep with the
 * StageRunner contract.
 *
 * What this runner does:
 *  1. Validates the venture is SaaS-shaped + intake transcript present
 *     + LLM caller wired (the underlying step throws otherwise).
 *  2. Invokes createSaasResearchReportsStep, which writes the founder-
 *     facing research markdowns under 01_research/saas/ via the
 *     injected Filesystem port.
 *  3. Maps each report outcome (written / skipped / failed) into a
 *     structured log entry + an entry on the artifact index. Files
 *     that were skipped because they already exist are still indexed
 *     -- they are valid artifacts the orchestrator should know about.
 *  4. Optionally creates a review gate if the manifest's
 *     pipeline.reviewGates list includes "RESEARCH". Default config
 *     does NOT include RESEARCH (defaults are BRAND + AUDIT) so most
 *     ventures advance straight to the next stage on success.
 *  5. Flushes the in-memory log buffer to .founder/logs/RESEARCH-<run>.jsonl
 *     in a finally block so failed runs still leave a trace.
 *
 * Naming note: this class is ResearchStageRunner. The package
 * @founder-os/research-runner is unrelated -- it's the HTTP client to
 * the Python research sidecar. The "StageRunner" suffix on the class
 * disambiguates.
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
import { createSaasResearchReportsStep } from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type ResearchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /** Concatenated chat transcript + attachment blocks. */
  intake: string;
  callLlm: SaasLlmCaller;
  /** Optional explicit runId; auto-generated if omitted. */
  runId?: string;
};

export class ResearchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "RESEARCH";
  private readonly intake: string;
  private readonly callLlm: SaasLlmCaller;

  constructor(opts: ResearchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.intake = opts.intake;
    this.callLlm = opts.callLlm;
  }

  /**
   * Preflight checks. Mirrors the hard guards inside the underlying
   * step (which throws if appType !== "saas") so the runner can
   * surface a structured error instead of letting the step throw.
   * The orchestrator calls validate() before run() and short-circuits
   * on a falsy result.
   */
  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];

    if (this.manifest.appType !== "saas") {
      errors.push(
        `RESEARCH runner expects manifest.appType === "saas", got "${this.manifest.appType}"`
      );
    }
    if (!this.intake.trim()) {
      missing.push("intake transcript");
    }
    if (typeof this.callLlm !== "function") {
      missing.push("LLM caller");
    }

    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "RESEARCH stage starting", { runId: this.runId, requiresReview });

    let artifactPaths: string[] = [];
    let reviewGateId: string | undefined;
    try {
      const result = await createSaasResearchReportsStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        intake: this.intake,
        callLlm: this.callLlm,
      });

      // Per-report logs. Written + skipped both produce a valid file on
      // disk, so both end up in the artifact index. Failed reports get
      // a warn log but no index entry.
      const indexEntries: ArtifactIndexEntry[] = [];
      const nowIso = new Date().toISOString();
      for (const outcome of result.outcomes) {
        if (outcome.status === "written") {
          this.log("info", `wrote ${outcome.spec.filename}`, { path: outcome.path });
          indexEntries.push({
            artifactId: `research:${outcome.spec.filename}`,
            stageName: "RESEARCH",
            type: "saas-research-report",
            path: outcome.path,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          });
        } else if (outcome.status === "skipped") {
          this.log("info", `skipped ${outcome.spec.filename}`, {
            path: outcome.path,
            reason: outcome.reason,
          });
          indexEntries.push({
            artifactId: `research:${outcome.spec.filename}`,
            stageName: "RESEARCH",
            type: "saas-research-report",
            path: outcome.path,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          });
        } else {
          this.log("warn", `failed ${outcome.spec.filename}`, {
            path: outcome.path,
            error: outcome.error,
          });
        }
      }

      artifactPaths = indexEntries.map((e) => e.path);
      await this.appendArtifactIndex(indexEntries);

      const success = result.status !== "failed";
      if (success && requiresReview) {
        const gate = this.buildReviewGate(artifactPaths);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
      this.log("info", "RESEARCH stage finished", {
        status: result.status,
        artifactsCreated: artifactPaths.length,
      });

      const errorPayload =
        result.status === "failed"
          ? ({
              code: "RESEARCH_REPORTS_ALL_FAILED",
              message: "All research reports failed -- see logs for per-report errors",
              recoverable: true,
            } as const)
          : undefined;

      const stageResult: StageRunResult = {
        success,
        stageName: "RESEARCH",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: success && requiresReview,
        nextStageReady: success && !requiresReview,
      };
      if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
      if (errorPayload !== undefined) stageResult.error = errorPayload;
      return stageResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", "RESEARCH stage threw", { error: message });
      return {
        success: false,
        stageName: "RESEARCH",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: "RESEARCH_STEP_THREW",
          message,
          // Most failures here are transient (LLM provider hiccup,
          // disk write race) -- safe to retry. The hard appType guard
          // would also surface here but validate() should catch that
          // before run() is called.
          recoverable: true,
        },
      };
    } finally {
      // Always flush logs -- failed runs are exactly the ones we most
      // want a trace of.
      try {
        await this.flushLogs();
      } catch (flushErr) {
        // Best-effort. Log to console so we don't lose visibility, but
        // don't throw -- a log-flush failure must not mask the real
        // run result.
        const msg = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for RESEARCH ${this.runId}: ${msg}`);
      }
    }
  }

  private buildReviewGate(artifactPaths: string[]): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: "saas-research-report",
        // For research the "human-readable content" is the file path
        // itself -- the desktop UI fetches and renders the markdown.
        // We avoid embedding the full body in the gate JSON so the
        // file stays bounded.
        humanReadableContent: p,
      })),
    };
  }
}
