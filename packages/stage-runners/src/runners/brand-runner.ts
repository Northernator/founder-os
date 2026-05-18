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
import type {
  Filesystem,
  NamingLlmCaller,
  OrchestratorLlmCaller,
} from "@founder-os/pipeline-runner";
import {
  createBrandBriefStep,
  createLogoPackStep,
  generateNamingCandidatesStep,
} from "@founder-os/pipeline-runner";
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { emitSourcedSectionsMarkdown } from "@founder-os/research-deep-core";
import { getBrandKitDir, getLogoExportsDir } from "@founder-os/workspace-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const BRAND_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-brand-positioning-landscape",
    question: "What positioning patterns, promises, and vocabulary are currently common in this venture's category?",
    angle: "competitor",
    priority: "must",
  },
  {
    id: "q-brand-naming-collision-risk",
    question: "Which naming collision risks, trademark-adjacent risks, domain conflicts, or social-handle conflicts should be avoided?",
    angle: "risk",
    priority: "must",
  },
  {
    id: "q-brand-voice-benchmarks",
    question: "Which voice, tone, and visual identity conventions are overused versus differentiated for this audience?",
    angle: "market",
    priority: "should",
  },
];

export type BrandStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * LLM caller for the naming step + creative fields in the brief
   * step. NamingLlmCaller and OrchestratorLlmCaller share the same
   * `({system, user}) => Promise<string>` shape so a single caller
   * works for both.
   */
  callLlm: NamingLlmCaller;
  /** Optional founder shortlist / "avoid these" hints, forwarded verbatim. */
  seedHints?: string;
  /** How many naming candidates to ask the LLM for. Default 8 (5-10 prompt). */
  targetCount?: number;
  enableDeepResearch?: boolean;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class BrandStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "BRAND";
  private readonly callLlm: NamingLlmCaller;
  private readonly seedHints: string | undefined;
  private readonly targetCount: number | undefined;
  private readonly enableDeepResearch: boolean;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: BrandStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.seedHints = opts.seedHints;
    this.targetCount = opts.targetCount;
    this.enableDeepResearch = opts.enableDeepResearch ?? false;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
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
      const deepResearch = await this.gatherBrandDeepResearch();
      // ----- Step 1: Naming candidates -----
      this.log("info", "generating naming candidates");
      const namingCtx = {
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        callLlm: this.callLlm,
        ...((this.seedHints !== undefined || deepResearch !== null)
          ? { seedHints: [this.seedHints, deepResearch?.seedHint].filter(Boolean).join("\n\n") }
          : {}),
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
      if (deepResearch !== null) {
        for (const path of deepResearch.artifacts) {
          indexEntries.push({
            artifactId: `brand:deep-research:${path.split("/").pop() ?? path}`,
            stageName: "BRAND",
            type: path.endsWith(".md") ? "brand-deep-research" : "brand-deep-research-json",
            path,
            createdAt: nowIso,
            status: "ready",
            runId: this.runId,
          });
        }
        artifactPaths.push(...deepResearch.artifacts);
      }

      // ----- Step 2: Brand brief -----
      this.log("info", "creating brand brief");
      // The callLlm injected here is NamingLlmCaller-shaped but the
      // brief step expects OrchestratorLlmCaller; both share the same
      // ({system, user}) => Promise<string> signature so the cast is
      // safe. Kept explicit so future signature drift in either type
      // surfaces as a compile error here.
      const briefResult = await createBrandBriefStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        callLlm: this.callLlm as unknown as OrchestratorLlmCaller,
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
      // Logo step now goes through the same LLM caller as the brief
      // step (subscription-CLI preferred, no image-gen API). The model
      // is asked for raw SVG markup, one call per archetype.
      const logoResult = await createLogoPackStep({
        fs: this.fs,
        ventureId: this.manifest.id,
        ventureRoot: this.ventureRoot,
        brief: briefResult.brief,
        callLlm: this.callLlm as unknown as OrchestratorLlmCaller,
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

  private async gatherBrandDeepResearch(): Promise<{ seedHint: string; artifacts: string[] } | null> {
    if (!this.enableDeepResearch) return null;
    try {
      this.log("info", "brand deep-research starting", {
        topicSlug: "brand-positioning-and-naming",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "brand-positioning-and-naming",
          label: "Brand positioning and naming collision risk",
        },
        questions: BRAND_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildBrandResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["BRAND", "LAUNCH", "HANDOFF_PACK"],
        staleAfterDays: 30,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "brand deep-research cache-hit" : "brand deep-research ready", {
        topicSlug: result.briefing.topicSlug,
        channelsUsed: result.briefing.channelsUsed,
        sources: result.briefing.sources.length,
      });
      return {
        seedHint: `### Deep research context for naming\n\n${excerptMarkdown(emitSourcedSectionsMarkdown(result.briefing), 1800)}`,
        artifacts: result.artifactsCreated.filter((path) => path.endsWith(".md") || path.endsWith(".json")),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("warn", "brand deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildBrandResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `Slug: ${this.manifest.slug}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      this.seedHints?.trim() ? `Founder brand hints:\n${this.seedHints.trim()}` : "",
    ].filter(Boolean);
    const intakePath = `${this.ventureRoot}/00_research/intake.md`;
    if (await this.fs.exists(intakePath)) {
      try {
        const intake = await this.fs.readFile(intakePath);
        if (intake.trim()) parts.push(`Founder intake:\n${excerptMarkdown(intake, 1600)}`);
      } catch {
        // Manifest + brand hints are enough to proceed.
      }
    }
    return parts.join("\n\n");
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
