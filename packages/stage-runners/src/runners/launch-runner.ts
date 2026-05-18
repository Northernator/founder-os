/**
 * LaunchStageRunner -- wraps createLaunchPackageStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - validate() requires manifest.id and manifest.name. The step
 *    itself is tolerant of missing upstream artifacts -- they all
 *    degrade to defaults and surface as warnings/fails on the
 *    pre-launch checklist.
 *  - run() always invokes createLaunchPackageStep. The step:
 *      1. reads brand brief / validation summary / finance plan /
 *         UK setup canvas / build handoff (best-effort);
 *      2. builds a pre-launch checklist;
 *      3. always writes 08_launch/launch-receipt.json +
 *         launch-announcement.md.
 *  - When `callLlm` is provided the step LLM-writes the announcement
 *    markdown. Without it a deterministic templated announcement.
 *  - Indexes BOTH artifacts.
 *  - Emits a "launch receipt written" log message on success -- log
 *    string kept verbatim for run-launch-stage.ts:deriveSteps and
 *    log-strings.test.ts.
 *
 * LAUNCH is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "business" -- a
 * "we are now live" decision is a business call.
 *
 * Idempotent: each run regenerates both files from the latest
 * upstream state. Safe to re-run after a rollback or post-launch
 * update.
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
import { createLaunchPackageStep } from "@founder-os/pipeline-runner";
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { emitSourcedSectionsMarkdown } from "@founder-os/research-deep-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const LAUNCH_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-launch-channel-benchmarks",
    question:
      "What are current ad CPC benchmarks, organic-channel algorithm states, and email/newsletter performance baselines for a UK SaaS targeting this ICP?",
    angle: "market",
    priority: "must",
  },
  {
    id: "q-launch-pr-templates",
    question:
      "Which PR / press / Product Hunt / Show HN templates and timing patterns are landing well right now for a category-adjacent SaaS launch?",
    angle: "market",
    priority: "should",
  },
  {
    id: "q-launch-channel-mix",
    question:
      "Given this venture's ICP and pricing, which 2-3 acquisition channels are most likely to compound over the first 90 days post-launch and what failure modes should be avoided?",
    angle: "risk",
    priority: "should",
  },
];

export type LaunchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-writes the
   * announcement; otherwise a deterministic templated announcement
   * is rendered.
   */
  callLlm?: SaasLlmCaller;
  /**
   * Gates the deep-research helper. Off by default so existing
   * deterministic + LLM-narrative paths keep their behaviour. When on
   * AND callLlm is set, the runner gathers a "launch-channel-benchmarks"
   * briefing and threads its excerpt into the announcement prompt.
   */
  enableDeepResearch?: boolean;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class LaunchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "LAUNCH";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly enableDeepResearch: boolean;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: LaunchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.enableDeepResearch = opts.enableDeepResearch ?? false;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for launch stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for launch stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "LAUNCH stage starting", {
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
      const deepResearch = await this.gatherLaunchDeepResearch();
      const stepCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
        ...(deepResearch !== null ? { deepResearch: [deepResearch.excerpt] } : {}),
      };
      const result = await createLaunchPackageStep(stepCtx);

      // Drift-protected log message: run-launch-stage.ts:deriveSteps
      // matches this string exactly, and log-strings.test.ts asserts it.
      // Don't change without updating both.
      this.log("info", "launch receipt written", {
        path: result.receiptPath,
        receiptStatus: result.receipt.status,
        generationSource: result.receipt.generationSource,
        sources: result.receipt.sources,
      });

      indexEntries.push({
        artifactId: "launch:receipt",
        stageName: "LAUNCH",
        type: "launch-receipt",
        path: result.receiptPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "launch:announcement",
        stageName: "LAUNCH",
        type: "launch-announcement",
        path: result.announcementPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(result.receiptPath, result.announcementPath);
      if (deepResearch !== null) {
        for (const path of deepResearch.artifacts) {
          indexEntries.push({
            artifactId: `launch:deep-research:${path.split("/").pop() ?? path}`,
            stageName: "LAUNCH",
            type: path.endsWith(".md") ? "launch-deep-research" : "launch-deep-research-json",
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
        const gate = this.buildReviewGate(result.receiptPath, result.announcementPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "LAUNCH_STEP_THREW";
      this.log("error", "LAUNCH stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for LAUNCH ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "LAUNCH",
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
      stageName: "LAUNCH",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private async gatherLaunchDeepResearch(): Promise<{
    excerpt: { filename: string; excerpt: string };
    artifacts: string[];
  } | null> {
    if (!this.enableDeepResearch || this.callLlm === undefined) return null;
    try {
      this.log("info", "launch deep-research starting", {
        topicSlug: "launch-channel-benchmarks",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "launch-channel-benchmarks",
          label: "Launch channel benchmarks and PR template current state",
        },
        questions: LAUNCH_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildLaunchResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["LAUNCH", "MEDIA", "HANDOFF_PACK"],
        staleAfterDays: 7,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "launch deep-research cache-hit" : "launch deep-research ready", {
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
      this.log("warn", "launch deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildLaunchResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      this.manifest.entityType ? `Entity type: ${this.manifest.entityType}` : "",
      `Flags: takesPayments=${this.manifest.takesPayments}, regulated=${this.manifest.regulated}, handlesPersonalData=${this.manifest.handlesPersonalData}, hiresStaff=${this.manifest.hiresStaff}`,
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

  private buildReviewGate(receiptPath: string, announcementPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: receiptPath, type: "launch-receipt", humanReadableContent: receiptPath },
        {
          path: announcementPath,
          type: "launch-announcement",
          humanReadableContent: announcementPath,
        },
      ],
    };
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
