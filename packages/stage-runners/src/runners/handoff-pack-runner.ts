/**
 * HandoffPackStageRunner -- slice 5 of the handoff-pack arc + slice 6
 * Tier-A LLM enrichment.
 *
 * Slice 5 promoted the skeletal runner to real, orchestrating the
 * Node-only `renderHandoffPackArtefactsStep` from
 * @founder-os/handoff-pack-providers/node, which itself wraps:
 *
 *   1. prepareBrandAssetsStep -- reads 03_brand/brand-kit/brand-brief.json
 *      and writes 13_handoff_pack/.brand/{brand-tokens.json,
 *      pdf-template-config.json,logo.svg/png}.
 *   2. renderAllStubsStep -- iterates DOC_MANIFEST, fills the
 *      Handlebars context from manifest + brand tokens, and emits
 *      one PDF per descriptor via the minimal-pdf engine (default).
 *
 * Slice 6 adds a third orchestrated step before the walker:
 *
 *   2a. dispatchGoldenSteps -- runs the 16 Tier-A render steps to
 *       produce contextOverrides (placeholder maps keyed by
 *       descriptor.id). Each step reads its prior-stage artefacts
 *       best-effort + optionally calls the runner-supplied
 *       GoldenLlmCaller. The walker then picks up the overrides so
 *       Tier-A docs come back as `generated` rather than `failed`
 *       under strict-mode placeholder substitution.
 *
 * The runner itself owns:
 *   - validate(): fail-closed if BRAND has not shipped (no
 *     03_brand/brand-kit/brand-brief.json on disk) per spec sec 5.
 *   - The drift-protected log strings from spec sec 9.
 *   - The HandoffPackCheckpoint envelope -- status="completed" or
 *     "failed", real counts from the walker's result.
 *   - The INDEX.md write through the Filesystem port (so tests
 *     with InMemoryFs see exactly what landed).
 *   - The artifact-index entries + optional review-gate.
 *   - Slice 6: a non-drift-protected diagnostic log line summarising
 *     the golden dispatcher's counts (completed/usedLlm/fallback/failed).
 *
 * Slice 10 adds role-pack assembly (renderRolePacksStep), so the
 * runner now indexes the 8 role-pack PDFs and stamps the checkpoint
 * with rolePacksGenerated.
 *
 * Drift-protected log strings (pinned by log-strings.test.ts):
 *   - "HANDOFF_PACK stage starting"
 *   - "Preparing brand assets in 13_handoff_pack/.brand/" (spec sec 9 #1)
 *   - "Rendered N PDFs into 13_handoff_pack/"             (spec sec 9 #2)
 *   - "Rendered 8 role packs into 13_handoff_pack/role-packs/" (spec sec 9 #3)
 *   - "Wrote inventory to 13_handoff_pack/INDEX.md"       (spec sec 9 #4)
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
  HANDOFF_PACK_INDEX_FILE_NAME,
  type HandoffPackCheckpoint,
  type HandoffPackInventory,
} from "@founder-os/handoff-pack-core";
import {
  DOC_MANIFEST_COUNT,
} from "@founder-os/handoff-pack-core/manifest";
import type {
  GoldenLlmCaller,
  RenderHandoffPackArtefactsOpts,
  RenderHandoffPackArtefactsResult,
} from "@founder-os/handoff-pack-providers/node";
import { renderHandoffPackArtefactsStep } from "@founder-os/handoff-pack-providers/node";
import type { Filesystem } from "@founder-os/pipeline-runner";
import {
  getBrandKitDir,
  getHandoffPackCheckpointPath,
  getHandoffPackDir,
  getHandoffPackIndexPath,
} from "@founder-os/workspace-core";

import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

export type RenderHandoffPackArtefactsFn = (
  opts: RenderHandoffPackArtefactsOpts
) => Promise<RenderHandoffPackArtefactsResult>;

export type HandoffPackStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId?: string;
  now?: () => Date;
  renderArtefacts?: RenderHandoffPackArtefactsFn;
  /**
   * Slice 6 -- optional Golden-16 LLM caller. Passed through to the
   * orchestrator; each Tier-A step falls back to deterministic
   * placeholder content when this is undefined OR when the call
   * throws. Subscription-first routing is the caller's responsibility
   * (the desktop wires the active provider when one is configured).
   */
  callLlm?: GoldenLlmCaller;
  /**
   * Slice 6 -- opt out of the Tier-A dispatcher (e.g. for stub-only
   * smoke tests). Default false.
   */
  skipGolden?: boolean;
  /**
   * Slice 7 -- opt out of the Tier-B dispatcher (same shape as
   * skipGolden -- useful when isolating slice-6 behaviour or running
   * stub-only smoke tests). Default false.
   */
  skipTierB?: boolean;
};

export type HandoffPackCheckpointShape = HandoffPackCheckpoint;

export class HandoffPackStageRunner
  extends BaseStageRunner
  implements StageRunner
{
  readonly stageName: StageName = "HANDOFF_PACK";
  private readonly now: () => Date;
  private readonly renderArtefacts: RenderHandoffPackArtefactsFn;
  private readonly callLlm?: GoldenLlmCaller;
  private readonly skipGolden: boolean;
  private readonly skipTierB: boolean;
  private readonly handoffPackConfig: VentureManifest["handoffPack"];

  constructor(opts: HandoffPackStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.now = opts.now ?? (() => new Date());
    this.renderArtefacts = opts.renderArtefacts ?? renderHandoffPackArtefactsStep;
    this.callLlm = opts.callLlm;
    this.skipGolden = opts.skipGolden ?? false;
    this.skipTierB = opts.skipTierB ?? false;
    this.handoffPackConfig = opts.manifest.handoffPack;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missingResources: string[] = [];
    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for handoff-pack stage");
    }
    if (!this.manifest.name?.trim()) {
      errors.push("manifest.name is required for handoff-pack stage");
    }
    if (this.handoffPackConfig?.enabled === false) {
      return { valid: true, missingResources, errors };
    }
    // Spec sec 5: BRAND is the hard prerequisite. No silent fallback
    // to "default theme" -- that defeats the point of branded docs.
    const brandBriefPath = `${getBrandKitDir(this.ventureRoot)}/brand-brief.json`;
    const brandShipped = await this.fs.exists(brandBriefPath);
    if (!brandShipped) {
      errors.push(
        `BRAND has not shipped -- expected ${brandBriefPath} not found. Run BRAND before HANDOFF_PACK.`,
      );
      missingResources.push(brandBriefPath);
    }
    return { valid: errors.length === 0, missingResources, errors };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    if (this.handoffPackConfig?.enabled === false) {
      this.log("info", "HANDOFF_PACK stage skipped", {
        runId: this.runId,
        reason: "manifest.handoffPack.enabled is false",
      });
      await this.flushLogs();
      return {
        success: true,
        stageName: "HANDOFF_PACK",
        runId: this.runId,
        artifactsCreated: [],
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: true,
      };
    }
    this.log("info", "HANDOFF_PACK stage starting", {
      runId: this.runId,
      requiresReview,
      totalDocs: DOC_MANIFEST_COUNT,
      goldenEnabled: !this.skipGolden,
      tierBEnabled: !this.skipTierB,
    });

    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const startedAt = this.now();
    const startedIso = startedAt.toISOString();
    let reviewGateId: string | undefined;
    let failureCode: string | undefined;
    let failureMessage: string | undefined;
    let artefacts: RenderHandoffPackArtefactsResult | undefined;
    let inventoryPath: string | undefined;

    try {
      await this.fs.mkdir(getHandoffPackDir(this.ventureRoot));

      this.log("info", "Preparing brand assets in 13_handoff_pack/.brand/", {
        ventureSlug: this.manifest.slug,
      });

      const renderArtefactsOpts: RenderHandoffPackArtefactsOpts = {
        ventureRoot: this.ventureRoot,
        ventureName: this.manifest.name,
        ventureSlug: this.manifest.slug,
        now: this.now,
        skipGolden: this.skipGolden,
        skipTierB: this.skipTierB,
      };
      if (this.handoffPackConfig?.excludeTiers) {
        renderArtefactsOpts.walkOverrides = {
          excludeTiers: this.handoffPackConfig.excludeTiers,
        };
      }
      if (this.handoffPackConfig?.includeRolePacks) {
        renderArtefactsOpts.includeRolePacks = this.handoffPackConfig.includeRolePacks;
      }
      if (this.handoffPackConfig?.customCoverNote) {
        renderArtefactsOpts.customCoverNote = this.handoffPackConfig.customCoverNote;
      }
      if (this.callLlm) {
        renderArtefactsOpts.callLlm = this.callLlm;
      }
      artefacts = await this.renderArtefacts(renderArtefactsOpts);

      // Slice 6 -- surface the dispatcher counts so the founder can
      // see how many Tier-A docs got LLM enrichment vs deterministic.
      // Not drift-protected: log-strings.test.ts does not pin this
      // message, since the count values are not stable across runs.
      if (artefacts.golden) {
        const g = artefacts.golden.counts;
        this.log("info", "Golden-16 dispatch complete", {
          completed: g.completed,
          usedLlm: g.usedLlm,
          deterministicFallback: g.deterministicFallback,
          failed: g.failed,
        });
      }

      // Slice 7 -- parallel Tier-B counter surface. Same not-drift-
      // protected status (counts vary across runs); the orchestrator's
      // notes still capture the tier-b: completed/usedLlm/... line for
      // checkpoint diagnostics.
      if (artefacts.tierB) {
        const t = artefacts.tierB.counts;
        this.log("info", "Tier-B dispatch complete", {
          completed: t.completed,
          usedLlm: t.usedLlm,
          deterministicFallback: t.deterministicFallback,
          failed: t.failed,
        });
      }

      const renderedCount =
        artefacts.walk.counts.generated +
        artefacts.walk.counts.partial +
        artefacts.walk.counts.stub +
        artefacts.walk.counts.manual;
      this.log("info", `Rendered ${renderedCount} PDFs into 13_handoff_pack/`, {
        generated: artefacts.walk.counts.generated,
        partial: artefacts.walk.counts.partial,
        stub: artefacts.walk.counts.stub,
        manual: artefacts.walk.counts.manual,
        failed: artefacts.walk.counts.failed,
        pending: artefacts.walk.counts.pending,
      });

      inventoryPath = getHandoffPackIndexPath(this.ventureRoot);
      await this.fs.writeFile(inventoryPath, artefacts.inventoryMarkdown);
      this.log("info", "Wrote inventory to 13_handoff_pack/INDEX.md", {
        path: inventoryPath,
        totalDocs: artefacts.inventory.totalDocs,
      });
      indexEntries.push(
        this.indexEntry(
          `handoff-pack-inventory-${this.runId}`,
          "handoff-pack-inventory",
          inventoryPath,
          startedIso,
        ),
      );
      artifactPaths.push(inventoryPath);

      const inventoryJsonPath = `${getHandoffPackDir(this.ventureRoot)}/handoff-pack-inventory.json`;
      await this.fs.writeFile(
        inventoryJsonPath,
        `${JSON.stringify(artefacts.inventory, null, 2)}\n`,
      );
      indexEntries.push(
        this.indexEntry(
          `handoff-pack-inventory-json-${this.runId}`,
          "handoff-pack-inventory-json",
          inventoryJsonPath,
          startedIso,
        ),
      );
      artifactPaths.push(inventoryJsonPath);

      if (artefacts.rolePacks) {
        for (const pack of artefacts.rolePacks.results) {
          if (pack.status !== "generated") continue;
          indexEntries.push(
            this.indexEntry(
              `handoff-pack-role-pack-${pack.role}-${this.runId}`,
              "handoff-pack-role-pack",
              pack.pdfPath,
              pack.renderedAt ?? startedIso,
            ),
          );
          artifactPaths.push(pack.pdfPath);
        }
        this.log(
          "info",
          `Rendered ${artefacts.rolePacks.counts.generated} role packs into 13_handoff_pack/role-packs/`,
          {
            generated: artefacts.rolePacks.counts.generated,
            skipped: artefacts.rolePacks.counts.skipped,
            failed: artefacts.rolePacks.counts.failed,
          },
        );
      }

      const checkpointPath = getHandoffPackCheckpointPath(this.ventureRoot);
      const finishedIso = this.now().toISOString();
      const checkpoint: HandoffPackCheckpoint = {
        runId: this.runId,
        ventureSlug: this.manifest.slug,
        startedAt: startedIso,
        finishedAt: finishedIso,
        status:
          artefacts.walk.counts.failed > 0 && renderedCount === 0
            ? "failed"
            : "completed",
        docsRendered: artefacts.walk.counts.generated,
        docsStubbed: artefacts.walk.counts.stub,
        docsPartial: artefacts.walk.counts.partial,
        docsFailed: artefacts.walk.counts.failed,
        rolePacksGenerated: artefacts.rolePacks?.counts.generated ?? 0,
        inventoryPath,
        notes: artefacts.notes,
      };
      await this.fs.writeFile(
        checkpointPath,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      indexEntries.push(
        this.indexEntry(
          `handoff-pack-checkpoint-${this.runId}`,
          "handoff-pack-checkpoint",
          checkpointPath,
          startedIso,
        ),
      );
      artifactPaths.push(checkpointPath);

      await this.appendArtifactIndex(indexEntries);

      if (requiresReview) {
        const gate = this.buildReviewGate(artifactPaths, artefacts.inventory);
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", {
          gateId: reviewGateId,
          reason: "configured review gate",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isBrandMissing =
        err instanceof Error &&
        (err.name === "HandoffPackBrandMissingError" ||
          message.toLowerCase().includes("brand stage has not shipped"));
      failureCode = isBrandMissing
        ? "HANDOFF_PACK_BRAND_MISSING"
        : "HANDOFF_PACK_RENDER_FAILED";
      failureMessage = message;
      this.log("error", "HANDOFF_PACK stage threw", {
        code: failureCode,
        error: message,
      });
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(
          `stage-runners: log flush failed for HANDOFF_PACK ${this.runId}: ${m}`,
        );
      }
    }

    if (failureCode !== undefined) {
      return {
        success: false,
        stageName: "HANDOFF_PACK",
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

    const result: StageRunResult = {
      success: true,
      stageName: "HANDOFF_PACK",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) result.reviewGateId = reviewGateId;
    return result;
  }

  private indexEntry(
    artifactId: string,
    type: string,
    path: string,
    nowIso: string,
  ): ArtifactIndexEntry {
    return {
      artifactId,
      stageName: "HANDOFF_PACK",
      type,
      path,
      createdAt: nowIso,
      status: "ready",
      runId: this.runId,
    };
  }

  private buildReviewGate(
    artifactPaths: string[],
    inventory: HandoffPackInventory,
  ): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      requiredApproval: "business",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: artifactPaths.map((p) => ({
        path: p,
        type: p.endsWith(HANDOFF_PACK_INDEX_FILE_NAME)
          ? "handoff-pack-inventory"
          : "handoff-pack-artifact",
        humanReadableContent:
          p.endsWith(HANDOFF_PACK_INDEX_FILE_NAME)
            ? `${inventory.totalDocs} docs across ${countCategories(inventory)} categories`
            : p,
      })),
    };
  }
}

function countCategories(inventory: HandoffPackInventory): number {
  const seen = new Set<string>();
  for (const e of inventory.entries) seen.add(e.category);
  return seen.size;
}
