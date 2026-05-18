/**
 * FinanceStageRunner -- wraps createFinancePlanStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - validate() requires manifest.id. The step itself is tolerant of
 *    missing upstream artifacts (validation summary, UK setup) --
 *    they all degrade to defaults.
 *  - run() always invokes createFinancePlanStep. The step:
 *      1. scaffolds 05_finance/finance-canvas.json with manifest
 *         defaults if missing (skip-if-exists);
 *      2. computes a forecast from canvas + manifest + validation
 *         summary + UK setup;
 *      3. always writes finance-plan.json + finance-plan.md.
 *  - When `callLlm` is provided the step LLM-enriches the plan\'s
 *    "Strategic narrative" markdown section. Without it a
 *    deterministic templated narrative is rendered.
 *  - Indexes ALL THREE artifacts (canvas + plan.json + plan.md).
 *  - Emits a "ensure-finance-canvas finished" log message on success
 *    -- kept verbatim for backwards compatibility with both desktop
 *    helper deriveSteps AND the log-strings drift-vitest, which has
 *    new-write + skip-if-exists test cases that both rely on this
 *    literal. Don\'t change without updating those.
 *
 * FINANCE is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "business" (a pricing
 * decision is a business call).
 *
 * Idempotent: the canvas is preserved on subsequent runs; the plan
 * is regenerated. Founder edits to the canvas survive every re-run.
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
import { createFinancePlanStep } from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type FinanceStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-enriches the
   * Strategic narrative. When omitted, deterministic narrative.
   */
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export class FinanceStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "FINANCE";
  private readonly callLlm: SaasLlmCaller | undefined;

  constructor(opts: FinanceStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for finance stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "FINANCE stage starting", {
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
      const result = await createFinancePlanStep(stepCtx);

      // Drift-protected log message. Two log-strings tests assert this
      // literal -- the new-write path AND the skip-if-exists path. The
      // step always writes the plan + handles canvas idempotently, so
      // emitting this message unconditionally keeps both green.
      this.log("info", "ensure-finance-canvas finished", {
        canvasStatus: result.canvasStatus,
        canvasPath: result.canvasPath,
        planJsonPath: result.planJsonPath,
        monthlyCostsGBP: result.plan.monthlyCosts.totalGBP,
        fundingPath: result.plan.fundingRecommendation.path,
        generationSource: result.plan.generationSource,
      });

      indexEntries.push({
        artifactId: "finance:canvas",
        stageName: "FINANCE",
        type: "finance-canvas",
        path: result.canvasPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "finance:plan-json",
        stageName: "FINANCE",
        type: "finance-plan",
        path: result.planJsonPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "finance:plan-markdown",
        stageName: "FINANCE",
        type: "finance-plan-markdown",
        path: result.planMdPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(result.canvasPath, result.planJsonPath, result.planMdPath);
      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(
          result.canvasPath,
          result.planJsonPath,
          result.planMdPath
        );
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "FINANCE_STEP_THREW";
      this.log("error", "FINANCE stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for FINANCE ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "FINANCE",
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
      stageName: "FINANCE",
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
    canvasPath: string,
    planJsonPath: string,
    planMdPath: string
  ): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: canvasPath, type: "finance-canvas", humanReadableContent: canvasPath },
        { path: planJsonPath, type: "finance-plan", humanReadableContent: planJsonPath },
        {
          path: planMdPath,
          type: "finance-plan-markdown",
          humanReadableContent: planMdPath,
        },
      ],
    };
  }
}
