/**
 * MediaStageRunner -- promoted from skeletal to real (slice 4 of media arc).
 *
 * Orchestrates four pipeline-runner steps under one StageRunner contract:
 *
 *   1. createMediaScriptStep    -- launch-announcement.md + brand brief
 *                                  -> MediaScript JSON + markdown.
 *                                  LLM-aware via optional callLlm
 *                                  (subscription-mode CLIs preferred per
 *                                  project policy).
 *   2. createStoryboardStep     -- MediaScript -> Storyboard with engine
 *                                  hints. Pure deterministic shaping.
 *   3. createRenderShotsStep    -- per-shot dispatch to providers (slice 4
 *                                  ships HyperFrames; later slices add
 *                                  Wan2/CogVideoX/Gemini-API). gemini_flow
 *                                  paste-in path writes flow-prompts.md
 *                                  and triggers a review-gate pause.
 *   4. createStitchStep         -- ffmpeg-concats per-shot MP4s into
 *                                  exports/launch-reel.mp4. Skipped when
 *                                  step 3 reported pending-flow.
 *
 * Behaviour
 * ---------
 *  - validate() requires manifest.id + name. Upstream artifacts (launch
 *    announcement, brand brief) are read best-effort by the steps; their
 *    absence degrades gracefully.
 *  - Indexed artifacts on success: media-script.json + .md, storyboard.json,
 *    flow-prompts.md (if pending), launch-reel.mp4 (if stitched).
 *  - Drift-protected log strings: "MEDIA stage starting", "media script
 *    written", "storyboard written", "render-shots finished" (with
 *    success/failed/pending counts), "launch reel stitched". A future
 *    run-media-stage.ts:deriveSteps + log-strings.test.ts pin them.
 *  - Pending-flow short-circuits the runner: review gate is required on
 *    the flow-prompts.md artifact, nextStageReady=false, founder pastes
 *    Flow output into renders/ and re-runs to advance.
 *  - MEDIA is NOT in DEFAULT_REVIEW_GATES. Opt in via pipeline.reviewGates
 *    -> requiredApproval = "business" (launch-reel content is a brand
 *    decision, not legal/security/design).
 *
 * Idempotent: each run regenerates everything from upstream state.
 * Re-running is safe and expected after a Flow paste-in.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { MediaProvider } from "@founder-os/media-core";
import type { Filesystem, SaasLlmCaller } from "@founder-os/pipeline-runner";
import {
  createMediaScriptStep,
  createRenderShotsStep,
  createStitchStep,
  createStoryboardStep,
} from "@founder-os/pipeline-runner";
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { emitSourcedSectionsMarkdown } from "@founder-os/research-deep-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const MEDIA_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-media-format-conventions",
    question:
      "What are the current per-platform format conventions (TikTok aspect, IG Reel length, YouTube Shorts duration, X/LinkedIn video sizing) for a UK SaaS launch reel?",
    angle: "technical",
    priority: "must",
  },
  {
    id: "q-media-hook-patterns",
    question:
      "Which opening-hook patterns and first-3-second conventions are landing well on each platform right now, and which look stale?",
    angle: "market",
    priority: "must",
  },
  {
    id: "q-media-captions-accessibility",
    question:
      "What captioning, on-screen text density, and accessibility baselines should the launch reel meet for current platform algorithms and UK WCAG expectations?",
    angle: "regulatory",
    priority: "should",
  },
];

export type MediaStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional SaaS LLM caller. Subscription-mode CLIs (Claude CLI /
   * Gemini CLI) are preferred per project policy -- callers
   * constructed via apps/founder-desktop's buildPipelineLlmCaller
   * already route there when available. When omitted, the script
   * step renders a deterministic templated narrative; the structural
   * JSON shape is identical either way.
   */
  callLlm?: SaasLlmCaller;
  /**
   * MediaProviders the runner can dispatch to. Slice 4 ships
   * HyperFrames; the desktop app builds it via
   * createHyperframesProvider() and passes it in. Empty array =
   * every shot falls through to the gemini_flow paste-in path.
   */
  providers?: ReadonlyArray<MediaProvider>;
  /**
   * Gates the deep-research helper. Off by default. When on AND callLlm
   * is set, the runner gathers a "media-format-conventions" briefing
   * BEFORE the script step and threads its excerpt into the
   * voiceover-enrichment LLM prompt.
   */
  enableDeepResearch?: boolean;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class MediaStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "MEDIA";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly providers: ReadonlyArray<MediaProvider>;
  private readonly enableDeepResearch: boolean;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: MediaStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.providers = opts.providers ?? [];
    this.enableDeepResearch = opts.enableDeepResearch ?? false;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!this.manifest.id?.trim()) errors.push("manifest.id is required for media stage");
    if (!this.manifest.name?.trim()) errors.push("manifest.name is required for media stage");
    return { valid: errors.length === 0, missingResources: [], errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "MEDIA stage starting", {
      runId: this.runId,
      requiresReview,
      withLlm: this.callLlm !== undefined,
      providerCount: this.providers.length,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let pendingFlow = false;

    try {
      const deepResearch = await this.gatherMediaDeepResearch();
      if (deepResearch !== null) {
        for (const path of deepResearch.artifacts) {
          indexEntries.push(
            this.indexEntry(
              `media:deep-research:${path.split("/").pop() ?? path}`,
              path.endsWith(".md") ? "media-deep-research" : "media-deep-research-json",
              path,
              nowIso,
            ),
          );
        }
        artifactPaths.push(...deepResearch.artifacts);
      }
      // Step 1: media script.
      const baseCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        runId: this.runId,
      };
      const scriptCtx = {
        ...baseCtx,
        ...(this.callLlm !== undefined ? { callLlm: this.callLlm } : {}),
        ...(deepResearch !== null ? { deepResearch: [deepResearch.excerpt] } : {}),
      };
      const scriptResult = await createMediaScriptStep(scriptCtx);
      this.log("info", "media script written", {
        path: scriptResult.jsonPath,
        sceneCount: scriptResult.script.scenes.length,
        generationSource: scriptResult.generationSource,
        sources: scriptResult.sources,
      });
      indexEntries.push(this.indexEntry("media:script-json", "media-script", scriptResult.jsonPath, nowIso));
      indexEntries.push(this.indexEntry("media:script-md", "media-script-markdown", scriptResult.mdPath, nowIso));
      artifactPaths.push(scriptResult.jsonPath, scriptResult.mdPath);

      // Step 2: storyboard.
      const storyboardResult = await createStoryboardStep({
        ...baseCtx,
        script: scriptResult.script,
      });
      this.log("info", "storyboard written", {
        path: storyboardResult.jsonPath,
        shotCount: storyboardResult.shotCount,
      });
      indexEntries.push(this.indexEntry("media:storyboard", "storyboard", storyboardResult.jsonPath, nowIso));
      artifactPaths.push(storyboardResult.jsonPath);

      // Step 3: render shots.
      const renderResult = await createRenderShotsStep({
        ...baseCtx,
        storyboard: storyboardResult.storyboard,
        providers: this.providers,
      });
      this.log("info", "render-shots finished", {
        rendersDir: renderResult.rendersDir,
        shotCount: renderResult.shotCount,
        success: renderResult.successCount,
        failures: renderResult.failureCount,
        pendingFlow: renderResult.pendingFlowCount,
        status: renderResult.status,
      });
      if (renderResult.flowPromptsPath) {
        indexEntries.push(
          this.indexEntry("media:flow-prompts", "media-flow-prompts", renderResult.flowPromptsPath, nowIso),
        );
        artifactPaths.push(renderResult.flowPromptsPath);
      }
      for (const r of renderResult.perShotResults) {
        if (r.status === "rendered") {
          indexEntries.push(
            this.indexEntry(`media:render-${r.sceneId}`, "media-render", r.path, nowIso),
          );
          artifactPaths.push(r.path);
        }
      }
      pendingFlow = renderResult.status === "pending-flow";

      // Step 4: stitch (only when render was clean).
      if (!pendingFlow && renderResult.failureCount === 0) {
        const renderedPaths = renderResult.perShotResults
          .filter((r): r is Extract<typeof r, { status: "rendered" }> => r.status === "rendered")
          .map((r) => r.path);
        const stitchResult = await createStitchStep({
          ...baseCtx,
          shotPaths: renderedPaths,
        });
        if (stitchResult.status === "done" && stitchResult.reelPath) {
          this.log("info", "launch reel stitched", {
            path: stitchResult.reelPath,
            shotCount: stitchResult.shotCount,
          });
          indexEntries.push(
            this.indexEntry("media:launch-reel", "launch-reel", stitchResult.reelPath, nowIso),
          );
          artifactPaths.push(stitchResult.reelPath);
        } else {
          this.log("warn", "launch reel skipped", {
            reason: stitchResult.reason ?? "unknown",
          });
        }
      }

      await this.appendArtifactIndex(indexEntries);

      // Pending-flow forces a review gate regardless of pipeline.reviewGates --
      // the founder MUST paste Flow output before MEDIA can advance.
      const needsGate = requiresReview || pendingFlow;
      if (needsGate) {
        const gate = this.buildReviewGate(artifactPaths, pendingFlow);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", {
          gateId: reviewGateId,
          reason: pendingFlow ? "pending-flow paste-in" : "configured review gate",
        });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "MEDIA_STEP_THREW";
      this.log("error", "MEDIA stage threw", { code: failureCode, error: message });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for MEDIA ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "MEDIA",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: { code: failureCode, message: failureMessage ?? "unknown", recoverable: true },
      };
    }

    const stageRequiresReview = requiresReview || pendingFlow;
    const stageResult: StageRunResult = {
      success: true,
      stageName: "MEDIA",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview: stageRequiresReview,
      nextStageReady: !stageRequiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "MEDIA",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildReviewGate(artifactPaths: string[], pendingFlow: boolean): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: pendingFlow && p.endsWith("flow-prompts.md") ? "media-flow-prompts" : "media-artifact",
        humanReadableContent: p,
      })),
    };
  }

  private async gatherMediaDeepResearch(): Promise<{
    excerpt: { filename: string; excerpt: string };
    artifacts: string[];
  } | null> {
    if (!this.enableDeepResearch || this.callLlm === undefined) return null;
    try {
      this.log("info", "media deep-research starting", {
        topicSlug: "media-format-conventions",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "media-format-conventions",
          label: "Per-platform format conventions and hook patterns for launch reels",
        },
        questions: MEDIA_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildMediaResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["MEDIA", "HANDOFF_PACK"],
        staleAfterDays: 7,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "media deep-research cache-hit" : "media deep-research ready", {
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
      this.log("warn", "media deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildMediaResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      `Flags: takesPayments=${this.manifest.takesPayments}, regulated=${this.manifest.regulated}, handlesPersonalData=${this.manifest.handlesPersonalData}`,
    ].filter(Boolean);
    const announcementPath = `${this.ventureRoot}/08_launch/launch-announcement.md`;
    if (await this.fs.exists(announcementPath)) {
      try {
        const announcement = await this.fs.readFile(announcementPath);
        if (announcement.trim()) parts.push(`Launch announcement excerpt:\n${excerptMarkdown(announcement, 1400)}`);
      } catch {
        // Manifest context is enough to proceed.
      }
    }
    return parts.join("\n\n");
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
