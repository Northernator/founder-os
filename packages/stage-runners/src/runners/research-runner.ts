/**
 * ResearchStageRunner -- writes the founder-facing SaaS research reports
 * through the shared deep-research vault.
 *
 * What this runner does:
 *  1. Validates the venture is SaaS-shaped + intake transcript present
 *     + LLM caller wired.
 *  2. Calls gatherDeepResearch() for each legacy report topic, then writes
 *     the sourced-section markdown under 01_research/saas/.
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
import {
  emitSourcedSectionsMarkdown,
  type CallLlm,
  type ResearchProvider,
  type ResearchQuestion,
  type RequestPasteIn,
} from "@founder-os/research-deep-core";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import { DEFAULT_MAX_COST_GBP_PER_TOPIC } from "@founder-os/research-deep-core";
import { getStagePath } from "@founder-os/workspace-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type ResearchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /** Concatenated chat transcript + attachment blocks. */
  intake: string;
  callLlm: SaasLlmCaller;
  workers?: ReadonlyArray<ResearchProvider>;
  plannerCallLlmChain?: ReadonlyArray<CallLlm>;
  requestPaste?: RequestPasteIn;
  maxCostGBPPerReport?: number;
  /** Optional explicit runId; auto-generated if omitted. */
  runId?: string;
};

type ResearchReportSpec = {
  filename: string;
  topic: { slug: string; label: string };
  questions: ResearchQuestion[];
};

type ResearchReportOutcome =
  | { spec: ResearchReportSpec; status: "written"; path: string }
  | { spec: ResearchReportSpec; status: "skipped"; path: string; reason: string }
  | { spec: ResearchReportSpec; status: "failed"; path: string; error: string };

const RESEARCH_REPORT_SPECS: readonly ResearchReportSpec[] = [
  {
    filename: "market-research.md",
    topic: { slug: "market-research", label: "Market Research Report" },
    questions: [
      q("q-market-size", "What is the current market size, growth direction, buyer urgency, and segment structure?", "market", "must"),
      q("q-market-risks", "Which market risks, timing factors, and external constraints could weaken the opportunity?", "risk", "should"),
    ],
  },
  {
    filename: "prd.md",
    topic: { slug: "prd", label: "Product Requirements Document" },
    questions: [
      q("q-product-problem", "Which customer problems should the product solve first, and what evidence supports that priority?", "customer", "must"),
      q("q-product-requirements", "What capabilities and constraints should shape the MVP requirements?", "technical", "must"),
    ],
  },
  {
    filename: "business-model-and-pricing.md",
    topic: { slug: "business-model-and-pricing", label: "Business Model and Pricing" },
    questions: [
      q("q-pricing-models", "What pricing models and price bands are credible for this segment now?", "financial", "must"),
      q("q-monetisation-risks", "What evidence suggests willingness to pay, budget ownership, and churn risk?", "customer", "must"),
    ],
  },
  {
    filename: "technical-architecture.md",
    topic: { slug: "technical-architecture", label: "Technical Architecture" },
    questions: [
      q("q-architecture-patterns", "Which current architecture patterns fit this SaaS product and expected scale?", "technical", "must"),
      q("q-platform-tradeoffs", "What platform, hosting, integration, and reliability tradeoffs should the build plan account for?", "technical", "should"),
    ],
  },
  {
    filename: "user-flows-and-wireframes.md",
    topic: { slug: "user-flows-and-wireframes", label: "User Flows and Wireframes" },
    questions: [
      q("q-user-flows", "What user journeys and activation moments are typical for this product category?", "customer", "must"),
      q("q-ux-patterns", "Which UX patterns reduce friction for this audience and workflow?", "technical", "should"),
    ],
  },
  {
    filename: "db-schema.md",
    topic: { slug: "db-schema", label: "Database Schema" },
    questions: [
      q("q-data-model", "What entities, relationships, and audit records are needed for this SaaS product?", "technical", "must"),
      q("q-data-risk", "Which data retention, privacy, and reporting risks should shape the schema?", "regulatory", "should"),
    ],
  },
  {
    filename: "api-contracts.md",
    topic: { slug: "api-contracts", label: "API Contracts" },
    questions: [
      q("q-api-surface", "What API surface, integration points, and automation hooks should the MVP expose?", "technical", "must"),
      q("q-api-conventions", "What auth, pagination, idempotency, and error conventions are appropriate?", "technical", "should"),
    ],
  },
  {
    filename: "security-and-permissions.md",
    topic: { slug: "security-and-permissions", label: "Security and Permissions" },
    questions: [
      q("q-security-baseline", "What security controls and permission boundaries are expected for this SaaS category?", "regulatory", "must"),
      q("q-threats", "What likely abuse, privacy, and operational risks should be mitigated from day one?", "risk", "must"),
    ],
  },
  {
    filename: "analytics-plan.md",
    topic: { slug: "analytics-plan", label: "Analytics Plan" },
    questions: [
      q("q-metrics", "Which activation, retention, revenue, and product-quality metrics matter for this venture?", "financial", "must"),
      q("q-instrumentation", "What events and reporting cuts should be instrumented in the MVP?", "technical", "should"),
    ],
  },
  {
    filename: "roadmap.md",
    topic: { slug: "roadmap", label: "Roadmap" },
    questions: [
      q("q-roadmap-sequence", "What milestone sequence best balances evidence, build risk, and commercial urgency?", "market", "must"),
      q("q-roadmap-risks", "Which dependencies and unknowns should gate each roadmap phase?", "risk", "should"),
    ],
  },
  {
    filename: "launch-plan.md",
    topic: { slug: "launch-plan", label: "Launch Plan" },
    questions: [
      q("q-launch-channels", "Which launch channels, communities, and acquisition motions are credible for this audience?", "market", "must"),
      q("q-launch-proof", "What proof points, offers, and risk reversals should the launch message include?", "customer", "should"),
    ],
  },
  {
    filename: "support-and-onboarding.md",
    topic: { slug: "support-and-onboarding", label: "Support and Onboarding" },
    questions: [
      q("q-onboarding", "What onboarding steps and support content reduce time-to-value for this product?", "customer", "must"),
      q("q-support-risk", "Which support workflows, SLAs, and escalation paths are appropriate at launch?", "risk", "should"),
    ],
  },
];

export class ResearchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "RESEARCH";
  private readonly intake: string;
  private readonly callLlm: SaasLlmCaller;
  private readonly workers: ReadonlyArray<ResearchProvider> | undefined;
  private readonly plannerCallLlmChain: ReadonlyArray<CallLlm> | undefined;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly maxCostGBPPerReport: number;

  constructor(opts: ResearchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.intake = opts.intake;
    this.callLlm = opts.callLlm;
    this.workers = opts.workers;
    this.plannerCallLlmChain = opts.plannerCallLlmChain;
    this.requestPaste = opts.requestPaste;
    this.maxCostGBPPerReport = opts.maxCostGBPPerReport ?? DEFAULT_MAX_COST_GBP_PER_TOPIC;
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
      const outcomes: ResearchReportOutcome[] = [];
      for (const spec of RESEARCH_REPORT_SPECS) {
        outcomes.push(await this.writeDeepResearchReport(spec));
      }

      // Per-report logs. Written + skipped both produce a valid file on
      // disk, so both end up in the artifact index. Failed reports get
      // a warn log but no index entry.
      const indexEntries: ArtifactIndexEntry[] = [];
      const nowIso = new Date().toISOString();
      for (const outcome of outcomes) {
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

      const anyWritten = outcomes.some((o) => o.status === "written");
      const anyFailed = outcomes.some((o) => o.status === "failed");
      const status: "done" | "partial" | "failed" = anyFailed
        ? anyWritten
          ? "partial"
          : "failed"
        : "done";
      const success = status !== "failed";
      if (success && requiresReview) {
        const gate = this.buildReviewGate(artifactPaths);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
      this.log("info", "RESEARCH stage finished", {
        status,
        artifactsCreated: artifactPaths.length,
      });

      const errorPayload =
        status === "failed"
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

  private async writeDeepResearchReport(spec: ResearchReportSpec): Promise<ResearchReportOutcome> {
    const outDir = `${getStagePath(this.ventureRoot, "research")}/saas`;
    const path = `${outDir}/${spec.filename}`;
    if (await this.fs.exists(path)) {
      return { spec, status: "skipped", path, reason: "exists" };
    }

    try {
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: spec.topic,
        questions: spec.questions,
        consumers: ["RESEARCH"],
        ventureContext: this.intake,
        callLlm: this.callLlm,
        plannerCallLlmChain: this.plannerCallLlmChain,
        workers: this.workers,
        requestPaste: this.requestPaste,
        maxCostGBP: this.maxCostGBPPerReport,
        projectedCostGBP: this.maxCostGBPPerReport,
        runId: this.runId,
        onProgress: (event) => {
          this.log(event.phase === "cross-reference-degraded" ? "warn" : "info", event.phase, {
            topicSlug: event.topicSlug,
          });
        },
      });
      await this.fs.writeFile(path, emitSourcedSectionsMarkdown(result.briefing));
      return { spec, status: "written", path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { spec, status: "failed", path, error: message };
    }
  }
}

function q(
  id: string,
  question: string,
  angle: ResearchQuestion["angle"],
  priority: ResearchQuestion["priority"]
): ResearchQuestion {
  return { id, question, angle, priority };
}
