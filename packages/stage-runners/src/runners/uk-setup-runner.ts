/**
 * UkSetupStageRunner -- wraps ensureUkSetupStep with the StageRunner contract.
 *
 * The UK setup stage runs a single deterministic pipeline step that
 * scaffolds 04_uk_business/uk-setup.json from manifest defaults. The
 * canvas is the source of truth for the UkSetupTab; the founder fills
 * it in interactively (entity registration, HMRC, VAT, ICO, insurance,
 * directors/PSC, policies). This runner only ensures the file exists
 * with sensible defaults so downstream stages and audit rules have
 * something to read.
 *
 * No LLM dependency. No network. Idempotent -- ensureUkSetupStep skips
 * when the canvas already exists.
 *
 * UK_SETUP is NOT in DEFAULT_REVIEW_GATES so the default flow advances
 * automatically. Founders who want a legal-review gate before
 * downstream stages can opt in via venture.yaml's pipeline.reviewGates
 * list. When triggered, requiredApproval = "legal" since the canvas
 * locks in entity type, registration choices, and compliance posture.
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
import { ensureUkSetupStep } from "@founder-os/pipeline-runner";
import type { ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { getUkSetupCanvasPath } from "@founder-os/workspace-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

const UK_SETUP_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-uk-companies-house",
    question: "What current Companies House incorporation, confirmation statement, PSC, and registered-office obligations apply to this venture?",
    angle: "regulatory",
    priority: "must",
  },
  {
    id: "q-uk-hmrc-vat",
    question: "What current HMRC corporation tax, PAYE, Self Assessment, and VAT threshold obligations should the founder consider?",
    angle: "financial",
    priority: "must",
  },
  {
    id: "q-uk-ico-gdpr",
    question: "What current ICO registration, UK GDPR, privacy policy, cookie, and data-processing requirements apply if the venture handles personal data?",
    angle: "regulatory",
    priority: "must",
  },
  {
    id: "q-uk-risk-insurance",
    question: "Which legal or operational risks, insurance needs, and compliance deadlines should be checked before launch?",
    angle: "risk",
    priority: "should",
  },
];

export type UkSetupStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  callLlm?: SaasLlmCaller;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
  runId?: string;
};

export class UkSetupStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "UK_SETUP";
  private readonly callLlm: SaasLlmCaller | undefined;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: UkSetupStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.callLlm = opts.callLlm;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for UK setup stage");
    }
    if (!this.manifest.entityType) {
      // entityType is required by VentureManifestSchema (it's an enum),
      // but the values include "undecided". The step still runs in that
      // case and the founder picks later via the UI -- we don't block.
      errors.push("manifest.entityType is required for UK setup stage");
    }

    return {
      valid: errors.length === 0,
      missingResources: [],
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "UK_SETUP stage starting", {
      runId: this.runId,
      requiresReview,
      entityType: this.manifest.entityType,
    });

    const canvasPath = getUkSetupCanvasPath(this.ventureRoot);
    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    try {
      const result = await ensureUkSetupStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
      });
      this.log("info", "ensure-uk-setup finished", {
        status: result.status,
        path: canvasPath,
      });
      const deepResearchArtifacts = await this.gatherUkSetupDeepResearch();

      indexEntries.push({
        artifactId: "uk-setup:canvas",
        stageName: "UK_SETUP",
        type: "uk-setup-canvas",
        path: canvasPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(canvasPath);
      for (const path of deepResearchArtifacts) {
        indexEntries.push({
          artifactId: `uk-setup:deep-research:${path.split("/").pop() ?? path}`,
          stageName: "UK_SETUP",
          type: path.endsWith(".md") ? "uk-setup-deep-research" : "uk-setup-deep-research-json",
          path,
          createdAt: nowIso,
          status: "ready",
          runId: this.runId,
        });
      }
      artifactPaths.push(...deepResearchArtifacts);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(canvasPath);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      }
      artifactPaths.push(...(await this.renderBrandedPdfsForStage()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failureMessage = message;
      failureCode = "UK_SETUP_STEP_THREW";
      this.log("error", "UK_SETUP stage threw", { code: failureCode, error: message });
      // Nothing partial to index -- single step, all-or-nothing. The
      // step's internal corrupt-canvas guard means parse failures
      // don't throw, they return defaults; only IO failures (mkdir,
      // writeFile) reach this catch.
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for UK_SETUP ${this.runId}: ${m}`);
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "UK_SETUP",
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
      stageName: "UK_SETUP",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(canvasPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      // UK setup decisions (entity type, VAT registration, ICO
      // registration, insurance) are compliance/legal -- not business
      // (BRAND) or design (PRODUCT_SPEC).
      requiredApproval: "legal",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: canvasPath, type: "uk-setup-canvas", humanReadableContent: canvasPath },
      ],
    };
  }

  private async gatherUkSetupDeepResearch(): Promise<string[]> {
    if (this.callLlm === undefined) return [];
    try {
      this.log("info", "uk-setup deep-research starting", {
        topicSlug: "uk-setup-compliance",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "uk-setup-compliance",
          label: "UK setup, tax, and data compliance",
        },
        questions: UK_SETUP_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildUkSetupResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["UK_SETUP", "FINANCE", "LAUNCH", "HANDOFF_PACK"],
        staleAfterDays: 7,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "uk-setup deep-research cache-hit" : "uk-setup deep-research ready", {
        topicSlug: result.briefing.topicSlug,
        channelsUsed: result.briefing.channelsUsed,
        sources: result.briefing.sources.length,
      });
      return result.artifactsCreated.filter((path) => path.endsWith(".md") || path.endsWith(".json"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("warn", "uk-setup deep-research skipped", { error: message });
      return [];
    }
  }

  private async buildUkSetupResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      `Entity type: ${this.manifest.entityType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      `Regulated: ${this.manifest.regulated}`,
      `Takes payments: ${this.manifest.takesPayments}`,
      `Handles personal data: ${this.manifest.handlesPersonalData}`,
      `Hires staff: ${this.manifest.hiresStaff}`,
    ].filter(Boolean);
    const intakePath = `${this.ventureRoot}/00_research/intake.md`;
    if (await this.fs.exists(intakePath)) {
      try {
        const intake = await this.fs.readFile(intakePath);
        if (intake.trim()) parts.push(`Founder intake:\n${excerptMarkdown(intake, 1600)}`);
      } catch {
        // Manifest flags are enough to proceed.
      }
    }
    return parts.join("\n\n");
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
