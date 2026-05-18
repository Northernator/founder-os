/**
 * renderHandoffPackArtefactsStep -- single Node-only entry point the
 * HandoffPackStageRunner calls to do all the "real work" for slice 5
 * (+ slice 6 Tier-A LLM enrichment).
 *
 * NODE-ONLY. Lives behind the /node entry point.
 *
 * What it does
 * ------------
 *   1. prepareBrandAssetsStep -- reads brand-brief.json, writes
 *      .brand/brand-tokens.json + .brand/pdf-template-config.json
 *      and copies the logo (best-effort).
 *   2. (slice 6) dispatchGoldenSteps -- runs the 16 Tier-A render
 *      steps, producing contextOverrides keyed by descriptor.id.
 *      Each step reads its prior-stage artefacts (best-effort) and
 *      optionally calls callLlm; deterministic-fallback on failure.
 *   3. renderAllStubsStep -- iterates DOC_MANIFEST and emits one
 *      PDF per descriptor via the configured PdfEngine. Tier-A docs
 *      pick up the slice-6 contextOverrides; Tier-B/C/D keep slice-5
 *      stub behaviour.
 *   4. Assembles a HandoffPackInventory envelope.
 *
 * What it intentionally does NOT do
 * ---------------------------------
 *   - per-stage progressive renders -- those land via the existing
 *     stage runners (slice 8 + 9)
 *   - desktop UI + per-venture HandoffPackConfig (slice 12+)
 *
 * Why a single function rather than four? The HandoffPackStageRunner
 * is one of fifteen stage runners and lives in the `stage-runners`
 * package, which already pulls in handoff-pack-core but should not
 * have to know about brand-asset extraction OR golden-step dispatch
 * OR descriptor walking OR the engine seam. Exporting one entry point
 * keeps the runner's implementation tight and lets every internal
 * detail evolve without touching stage-runners.
 */
import {
  HANDOFF_PACK_INDEX_FILE_NAME,
  type BrandTokens,
  type HandoffPackInventory,
  type Role,
  type PdfTemplateConfig,
  type Tier,
} from "@founder-os/handoff-pack-core";
import { renderInventoryMarkdown } from "../inventory-markdown.js";
import {
  HandoffPackBrandMissingError,
  type PdfEngine,
  type PrepareBrandAssetsResult,
} from "../types.js";
import {
  dispatchGoldenSteps,
  type DispatchGoldenStepsResult,
  type GoldenLlmCaller,
} from "./golden/index.js";
import {
  dispatchTierBSteps,
  type DispatchTierBStepsResult,
} from "./tier-b/index.js";
import { createMinimalPdfEngine } from "./minimal-pdf-engine.js";
import {
  prepareBrandAssetsStep,
  type PrepareBrandAssetsOpts,
} from "./prepare-brand-assets.js";
import {
  renderAllStubsStep,
  type RenderAllStubsStepOpts,
  type RenderAllStubsStepResult,
} from "./render-all-stubs.js";
import {
  renderRolePacksStep,
  type RenderRolePacksStepResult,
} from "./render-role-packs.js";

export type RenderHandoffPackArtefactsOpts = {
  ventureRoot: string;
  ventureName: string;
  ventureSlug: string;
  /** Optional override for prepareBrandAssetsStep (tests). */
  prepareOverrides?: Pick<
    PrepareBrandAssetsOpts,
    "brandBriefPath" | "logoSvgSourcePath"
  >;
  /** Optional override for renderAllStubsStep (tests). */
  walkOverrides?: Pick<
    RenderAllStubsStepOpts,
    "templatesRoot" | "limit" | "contextOverrides" | "excludeTiers"
  >;
  /** PdfEngine to drive. Default: createMinimalPdfEngine(). */
  engine?: PdfEngine;
  /** Clock for deterministic tests. */
  now?: () => Date;
  /**
   * Slice 6 -- optional LLM caller passed to dispatchGoldenSteps.
   * When undefined, the Golden 16 fall back to deterministic
   * placeholder content. Subscription-first routing is the caller's
   * responsibility (per subscription_preferred_routing memo) -- the
   * runner picks the active provider and injects whichever it has.
   */
  callLlm?: GoldenLlmCaller;
  /**
   * Slice 6 -- opt out of the Golden-16 dispatch (e.g. for stub-only
   * smoke tests). Default false -- Golden runs whenever the orchestrator
   * is called.
   */
  skipGolden?: boolean;
  /**
   * Slice 7 -- opt out of the Tier-B dispatch. Same shape as skipGolden.
   * Default false -- Tier-B runs whenever the orchestrator is called.
   * Useful for stub-only smoke tests + for isolating slice-6 changes
   * during integration debugging.
   */
  skipTierB?: boolean;
  includeRolePacks?: ReadonlyArray<Role>;
  customCoverNote?: string;
};

export type RenderHandoffPackArtefactsResult = {
  brand: PrepareBrandAssetsResult;
  inventory: HandoffPackInventory;
  inventoryMarkdown: string;
  walk: RenderAllStubsStepResult;
  /** Slice 6 -- dispatcher result. Absent when skipGolden=true. */
  golden?: DispatchGoldenStepsResult;
  /** Slice 7 -- Tier-B dispatcher result. Absent when skipTierB=true. */
  tierB?: DispatchTierBStepsResult;
  /** Slice 10 -- role-pack assembly result. */
  rolePacks?: RenderRolePacksStepResult;
  /** Notes the orchestrator should surface in the runner's checkpoint. */
  notes: string[];
};

export async function renderHandoffPackArtefactsStep(
  opts: RenderHandoffPackArtefactsOpts
): Promise<RenderHandoffPackArtefactsResult> {
  const now = opts.now ?? (() => new Date());
  const engine = opts.engine ?? createMinimalPdfEngine({ now });

  // 1. Brand assets. prepareBrandAssetsStep throws
  //    HandoffPackBrandMissingError when BRAND has not shipped -- the
  //    runner converts that into a fail-closed StageRunResult before
  //    the walker runs (so we don't write a partial pack).
  const brand = await prepareBrandAssetsStep({
    ventureRoot: opts.ventureRoot,
    ventureName: opts.ventureName,
    now,
    ...(opts.prepareOverrides ?? {}),
  });
  const pdfConfig: PdfTemplateConfig = opts.customCoverNote
    ? { ...brand.config, footerConfidentialityNote: opts.customCoverNote }
    : brand.config;

  // 2. Slice 6 -- run the Golden 16 dispatcher to produce
  //    contextOverrides for the Tier-A docs. Each step reads its
  //    prior-stage artefacts best-effort; missing artefacts degrade
  //    to deterministic TODO callouts rather than failing.
  let golden: DispatchGoldenStepsResult | undefined;
  let goldenOverrides: Record<string, Record<string, string>> = {};
  if (!opts.skipGolden) {
    golden = await dispatchGoldenSteps({
      ventureRoot: opts.ventureRoot,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      brandTokens: brand.tokens,
      now,
      callLlm: opts.callLlm,
    });
    goldenOverrides = golden.contextOverrides;
  }

  // 2b. Slice 7 -- run the Tier-B dispatcher to produce additional
  //     contextOverrides for the 27 Tier-B docs. Same shape and same
  //     deterministic-fallback semantics as the Golden 16. The two
  //     dispatchers target disjoint docId sets so order does not
  //     affect correctness; we run Tier-B second simply because it is
  //     lower-fidelity and slice-6's GoldenStep contract is the
  //     reference shape.
  let tierB: DispatchTierBStepsResult | undefined;
  let tierBOverrides: Record<string, Record<string, string>> = {};
  if (!opts.skipTierB) {
    tierB = await dispatchTierBSteps({
      ventureRoot: opts.ventureRoot,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      brandTokens: brand.tokens,
      now,
      callLlm: opts.callLlm,
    });
    tierBOverrides = tierB.contextOverrides;
  }

  // Merge slice-6 golden + slice-7 tier-B overrides, then layer any
  // test-supplied overrides on top so fixtures can pin specific docs.
  // Golden and Tier-B target disjoint docIds in the manifest so there
  // should never be a collision; we still spread in registry order
  // (golden then tierB) for predictable test output.
  const mergedOverrides: Record<string, Record<string, string>> = {
    ...goldenOverrides,
    ...tierBOverrides,
  };
  const testOverrides = opts.walkOverrides?.contextOverrides ?? {};
  for (const [docId, fields] of Object.entries(testOverrides)) {
    mergedOverrides[docId] = { ...mergedOverrides[docId], ...fields };
  }

  // 3. Render every doc. Tier-A descriptors pick up the golden
  //    overrides; Tier-B/C/D keep the slice-5 stub behaviour.
  const walk = await renderAllStubsStep({
    ventureRoot: opts.ventureRoot,
    ventureName: opts.ventureName,
    ventureSlug: opts.ventureSlug,
    tokens: brand.tokens,
    config: pdfConfig,
    engine,
    now,
    templatesRoot: opts.walkOverrides?.templatesRoot,
    limit: opts.walkOverrides?.limit,
    excludeTiers: opts.walkOverrides?.excludeTiers,
    contextOverrides: mergedOverrides,
  });

  // 4. Slice 10 -- assemble role-pack PDFs after individual docs exist.
  const rolePacks = await renderRolePacksStep({
    ventureRoot: opts.ventureRoot,
    ventureName: opts.ventureName,
    ventureSlug: opts.ventureSlug,
    tokens: brand.tokens,
    config: pdfConfig,
    engine,
    now,
    inventoryEntries: walk.entries,
    includeRoles: opts.includeRolePacks,
  });

  // 5. Assemble inventory envelope.
  const inventory: HandoffPackInventory = {
    generatedAt: now().toISOString(),
    ventureSlug: opts.ventureSlug,
    ventureName: opts.ventureName,
    totalDocs: walk.entries.length,
    entries: walk.entries,
    rolePacks: rolePacks.rolePacks,
  };

  const inventoryMarkdown = renderInventoryMarkdown({ inventory });

  const orchestratorNotes: string[] = [
    ...brand.notes,
    ...(golden ? golden.notes : []),
    ...(tierB ? tierB.notes : []),
    ...walk.notes,
    ...rolePacks.notes,
    `index.md basename: ${HANDOFF_PACK_INDEX_FILE_NAME}`,
  ];
  if (golden) {
    orchestratorNotes.push(
      `golden: completed=${golden.counts.completed} usedLlm=${golden.counts.usedLlm} fallback=${golden.counts.deterministicFallback} failed=${golden.counts.failed}`
    );
  }
  if (tierB) {
    orchestratorNotes.push(
      `tier-b: completed=${tierB.counts.completed} usedLlm=${tierB.counts.usedLlm} fallback=${tierB.counts.deterministicFallback} failed=${tierB.counts.failed}`
    );
  }

  return {
    brand,
    inventory,
    inventoryMarkdown,
    walk,
    ...(golden ? { golden } : {}),
    ...(tierB ? { tierB } : {}),
    rolePacks,
    notes: orchestratorNotes,
  };
}

// Re-export the brand-missing error so callers can branch on it
// without juggling two imports.
export { HandoffPackBrandMissingError };

// Re-export tier + tokens types so the runner can hold typed
// references without pulling handoff-pack-core itself for the
// inventory envelope. (Stage-runners DOES depend on
// handoff-pack-core, but co-locating the type re-exports keeps the
// runner side clean.)
export type { BrandTokens, PdfTemplateConfig, Tier };

// Slice 6 -- re-export the caller type so the runner side can hold a
// typed reference without juggling two import paths.
export type { GoldenLlmCaller };
