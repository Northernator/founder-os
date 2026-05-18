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
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { emitSourcedSectionsMarkdown } from "@founder-os/research-deep-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const FINANCE_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-finance-uk-saas-benchmarks",
    question:
      "What are current UK SaaS benchmark costs (hosting, payroll, accountants, transactional email) for an early-stage venture at this scale?",
    angle: "financial",
    priority: "must",
  },
  {
    id: "q-finance-tax-credits-vat",
    question:
      "Which R&D tax credit / SME relief eligibility rules, VAT thresholds, and Companies House / HMRC obligations apply right now to this venture's entity type and activities?",
    angle: "regulatory",
    priority: "must",
  },
  {
    id: "q-finance-funding-routes",
    question:
      "Which funding routes (bootstrap, friends-and-family, pre-seed, grants) are realistic for this venture's burn profile and validation evidence?",
    angle: "financial",
    priority: "should",
  },
];

export type FinanceStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-enriches the
   * Strategic narrative. When omitted, deterministic narrative.
   */
  callLlm?: SaasLlmCaller;
  /**
   * Gates the deep-research helper. Off by default so existing
   * deterministic + LLM-narrative paths keep their behaviour. When on
   * AND callLlm is set, the runner gathers a "finance-uk-saas-benchmarks"
   * briefing and threads its excerpt into the narrative prompt.
   */
  enableDeepResearch?: boolean;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class FinanceStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "FINANCE";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly enableDeepResearch: boolean;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: FinanceStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.enableDeepResearch = opts.enableDeepResearch ?? false;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
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
      const deepResearch = await this.gatherFinanceDeepResearch();
      const stepCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
        ...(deepResearch !== null ? { deepResearch: [deepResearch.excerpt] } : {}),
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
      if (deepResearch !== null) {
        for (const path of deepResearch.artifacts) {
          indexEntries.push({
            artifactId: `finance:deep-research:${path.split("/").pop() ?? path}`,
            stageName: "FINANCE",
            type: path.endsWith(".md") ? "finance-deep-research" : "finance-deep-research-json",
            path,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          });
        }
        artifactPaths.push(...deepResearch.artifacts);
      }
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

  private async gatherFinanceDeepResearch(): Promise<{
    excerpt: { filename: string; excerpt: string };
    artifacts: string[];
  } | null> {
    if (!this.enableDeepResearch || this.callLlm === undefined) return null;
    try {
      this.log("info", "finance deep-research starting", {
        topicSlug: "finance-uk-saas-benchmarks",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "finance-uk-saas-benchmarks",
          label: "UK SaaS finance benchmarks and tax/VAT eligibility",
        },
        questions: FINANCE_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildFinanceResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["FINANCE", "LAUNCH", "HANDOFF_PACK"],
        staleAfterDays: 7,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "finance deep-research cache-hit" : "finance deep-research ready", {
        topicSlug: result.briefing.topicSlug,
        channelsUsed: result.briefing.channelsUsed,
        sources: result.briefing.sources.length,
      });
      return {
        excerpt: {
          filename: `${result.briefing.topicSlug}.md`,
          excerpt: excerptMarkdown(emitSourcedSectionsMarkdown(result.briefing), 1800),
        },
        artifacts: result.artifactsCreated.filter((path) => path.endsWith(".md") || path.endsWith(".json")),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("warn", "finance deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildFinanceResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      this.manifest.entityType ? `Entity type: ${this.manifest.entityType}` : "",
      `Flags: takesPayments=${this.manifest.takesPayments}, regulated=${this.manifest.regulated}, handlesPersonalData=${this.manifest.handlesPersonalData}, hiresStaff=${this.manifest.hiresStaff}`,
      this.manifest.monthlyBudgetCapGBP !== undefined && this.manifest.monthlyBudgetCapGBP !== null
        ? `Monthly budget cap: GBP ${this.manifest.monthlyBudgetCapGBP}`
        : "",
    ].filter(Boolean);
    const intakePath = `${this.ventureRoot}/00_research/intake.md`;
    if (await this.fs.exists(intakePath)) {
      try {
        const intake = await this.fs.readFile(intakePath);
        if (intake.trim()) parts.push(`Founder intake:\n${excerptMarkdown(intake, 1600)}`);
      } catch {
        // Manifest context is enough to proceed.
      }
    }
    return parts.join("\n\n");
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

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
