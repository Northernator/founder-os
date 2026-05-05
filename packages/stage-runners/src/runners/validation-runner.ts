/**
 * ValidationStageRunner -- wraps createValidationSummaryStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - Always invokes createValidationSummaryStep (the runner has no
 *    "skeletal placeholder" path anymore -- the step itself produces
 *    a useful summary even when inputs are sparse).
 *  - When `callLlm` is provided the step LLM-enriches the markdown
 *    Go/no-go take section. Without `callLlm` the step renders a
 *    deterministic templated narrative; either way the structured
 *    JSON shape is identical so downstream consumers do not branch.
 *  - Indexes both validation-summary.md AND validation-summary.json
 *    on the artifact index. The .json is the machine-readable
 *    contract; the .md is what the founder reads.
 *  - Emits a "validation checkpoint written" log on success. The log
 *    string is parsed by the desktop helper run-validation-stage.ts
 *    (deriveSteps) and pinned by the log-strings drift-vitest.
 *
 * VALIDATION is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "business" (a
 * go/no-go is a business decision, not legal/security/design).
 *
 * Idempotent: the step always overwrites the summary files with the
 * latest canvas state. The canvas itself is never touched.
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
import { createValidationSummaryStep } from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type ValidationStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the validation summary step
   * LLM-enriches the markdown Go/no-go take. When omitted, the step
   * still produces a useful deterministic summary. Either path is
   * supported -- the runner does not require an LLM caller in
   * validate().
   */
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export class ValidationStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "VALIDATION";
  private readonly callLlm: SaasLlmCaller | undefined;

  constructor(opts: ValidationStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for validation stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for validation stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "VALIDATION stage starting", {
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
      const result = await createValidationSummaryStep(stepCtx);

      // Drift-protected log message: run-validation-stage.ts:deriveSteps
      // matches this string exactly, and log-strings.test.ts asserts it.
      // Don't change this without updating both.
      this.log("info", "validation checkpoint written", {
        path: result.jsonPath,
        decision: result.summary.decision,
        summarySource: result.summary.summarySource,
        sources: result.summary.sources,
      });

      indexEntries.push({
        artifactId: "validation:summary-json",
        stageName: "VALIDATION",
        type: "validation-summary",
        path: result.jsonPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "validation:summary-markdown",
        stageName: "VALIDATION",
        type: "validation-summary-markdown",
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
      failureCode = "VALIDATION_STEP_THREW";
      this.log("error", "VALIDATION stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for VALIDATION ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "VALIDATION",
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
      stageName: "VALIDATION",
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
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: jsonPath, type: "validation-summary", humanReadableContent: jsonPath },
        {
          path: mdPath,
          type: "validation-summary-markdown",
          humanReadableContent: mdPath,
        },
      ],
    };
  }
}
