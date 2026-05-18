/**
 * WireframeStageRunner -- wraps createWireframesStep with the
 * StageRunner contract.
 *
 * Behaviour:
 *  - validate() requires manifest.id + the screens canvas at
 *    06_product/wireframes/screens-canvas.json. The canvas is
 *    produced by ProductStageRunner via ensureScreensStep; if missing,
 *    the orchestrator routes through interpret() and surfaces the
 *    "run PRODUCT_SPEC stage first" message in the FailedRunBanner.
 *  - run() always invokes createWireframesStep (the runner has no
 *    "skeletal placeholder" path anymore -- the step itself produces
 *    a useful wireframe checkpoint even when the canvas is empty).
 *  - When `callLlm` is provided the step LLM-enriches each screen\'s
 *    "Layout & states" narrative; without it the step renders a
 *    deterministic templated narrative keyed off the shellType.
 *  - Indexes BOTH wireframe-checkpoint.json AND wireframes.md on
 *    the artifact index. The .json is the machine-readable contract;
 *    the .md is what designers and the founder review.
 *  - Emits a "wireframe checkpoint written" log on success. The log
 *    string is parsed by the desktop helper run-wireframe-stage.ts
 *    (deriveSteps) and pinned by the log-strings drift-vitest.
 *
 * WIREFRAME is NOT in DEFAULT_REVIEW_GATES. When opted in via
 * pipeline.reviewGates the requiredApproval is "design".
 *
 * Idempotent: the step always overwrites both summary files with
 * the latest screens-canvas state. The screens canvas is never
 * touched.
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
import { createWireframesStep } from "@founder-os/pipeline-runner";
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { emitSourcedSectionsMarkdown } from "@founder-os/research-deep-core";
import { getScreensCanvasPath } from "@founder-os/workspace-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const WIREFRAME_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-wireframe-screen-patterns",
    question: "What current screen-pattern conventions and interaction models are best-in-class for this category?",
    angle: "technical",
    priority: "must",
  },
  {
    id: "q-wireframe-empty-error-states",
    question: "Which loading, empty, error, onboarding, and mobile-responsive states should be reflected in low-fidelity wireframes?",
    angle: "technical",
    priority: "should",
  },
];

export type WireframeStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional LLM caller. When provided, the step LLM-enriches per-
   * screen narratives. When omitted, deterministic templated
   * narratives are used. Either path is supported; the runner does
   * not require an LLM caller in validate().
   */
  callLlm?: SaasLlmCaller;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class WireframeStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "WIREFRAME";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: WireframeStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missing: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for wireframe stage");
    const screensPath = getScreensCanvasPath(this.ventureRoot);
    if (!(await this.fs.exists(screensPath))) {
      missing.push(`screens canvas at ${screensPath} (run PRODUCT_SPEC stage first)`);
    }
    return {
      valid: errors.length === 0 && missing.length === 0,
      missingResources: missing,
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "WIREFRAME stage starting", {
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
      const deepResearch = await this.gatherWireframeDeepResearch();
      const stepCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
        ...(deepResearch !== null ? { deepResearch: [deepResearch.excerpt] } : {}),
      };
      const result = await createWireframesStep(stepCtx);

      // Drift-protected log message: run-wireframe-stage.ts:deriveSteps
      // matches this string exactly, and log-strings.test.ts asserts it.
      // Don't change this without updating both.
      this.log("info", "wireframe checkpoint written", {
        path: result.jsonPath,
        totalScreens: result.checkpoint.summary.totalScreens,
        generationSource: result.checkpoint.generationSource,
        sources: result.checkpoint.sources,
      });

      indexEntries.push({
        artifactId: "wireframe:checkpoint",
        stageName: "WIREFRAME",
        type: "wireframe-checkpoint",
        path: result.jsonPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      indexEntries.push({
        artifactId: "wireframe:markdown",
        stageName: "WIREFRAME",
        type: "wireframe-markdown",
        path: result.mdPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(result.jsonPath, result.mdPath);
      if (deepResearch !== null) {
        for (const path of deepResearch.artifacts) {
          indexEntries.push({
            artifactId: `wireframe:deep-research:${path.split("/").pop() ?? path}`,
            stageName: "WIREFRAME",
            type: path.endsWith(".md") ? "wireframe-deep-research" : "wireframe-deep-research-json",
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
        const gate = this.buildReviewGate(result.jsonPath, result.mdPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "WIREFRAME_STEP_THREW";
      this.log("error", "WIREFRAME stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for WIREFRAME ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "WIREFRAME",
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
      stageName: "WIREFRAME",
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
      requiredApproval: "design",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: jsonPath, type: "wireframe-checkpoint", humanReadableContent: jsonPath },
        { path: mdPath, type: "wireframe-markdown", humanReadableContent: mdPath },
      ],
    };
  }

  private async gatherWireframeDeepResearch(): Promise<{
    excerpt: { filename: string; excerpt: string };
    artifacts: string[];
  } | null> {
    if (this.callLlm === undefined) return null;
    try {
      this.log("info", "wireframe deep-research starting", {
        topicSlug: "wireframe-screen-patterns",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "wireframe-screen-patterns",
          label: "Wireframe screen-pattern conventions",
        },
        questions: WIREFRAME_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildWireframeResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["WIREFRAME", "HANDOFF", "BUILD", "HANDOFF_PACK"],
        staleAfterDays: 30,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "wireframe deep-research cache-hit" : "wireframe deep-research ready", {
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
      this.log("warn", "wireframe deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildWireframeResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
    ].filter(Boolean);
    const screensPath = getScreensCanvasPath(this.ventureRoot);
    if (await this.fs.exists(screensPath)) {
      try {
        const screens = await this.fs.readFile(screensPath);
        if (screens.trim()) parts.push(`Screens canvas:\n${excerptMarkdown(screens, 1800)}`);
      } catch {
        // validate() already checks existence; ignore read errors here.
      }
    }
    return parts.join("\n\n");
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
