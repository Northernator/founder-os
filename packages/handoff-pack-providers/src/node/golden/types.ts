/**
 * Slice 6 -- shared types for the Tier-A "Golden 16" render steps.
 *
 * NODE-ONLY. Lives behind the /node entry point because each
 * createXxxStep reads prior-stage artefacts off disk.
 *
 * Slice 6 promotes the HANDOFF_PACK orchestrator from "all stubs"
 * to "16 LLM-aware Tier-A renders + the rest as stubs". Each step:
 *
 *   1. Reads its declared prior-stage artefacts (e.g.
 *      03_brand/brand-kit/brand-brief.json, 06_product/specs/
 *      spec-canvas.json). Missing artefacts are non-fatal -- the
 *      step degrades to TODO callouts so the founder still gets a
 *      branded PDF skeleton.
 *   2. Optionally calls an LLM (via the same SaaS-style caller
 *      pattern as createValidationSummaryStep / createFinancePlanStep)
 *      to fill the high-value narrative slots.
 *   3. Returns a placeholder map keyed by descriptor.placeholders.
 *      The dispatcher merges all 16 into the contextOverrides
 *      record the slice-5 renderAllStubsStep already consumes.
 *
 * Subscription-first LLM routing -- per
 * subscription_preferred_routing -- is the caller's responsibility:
 * the runner injects whichever provider it has wired (gemini /
 * anthropic / openai). When no provider is available, callLlm is
 * undefined and the deterministic branch runs unconditionally.
 */
import type { BrandTokens } from "@founder-os/handoff-pack-core";

/**
 * SaaS-style LLM caller. Matches the shape used by
 * createValidationSummaryStep / createFinancePlanStep so callers can
 * reuse the same plumbing. Returns the raw model text -- the step is
 * responsible for parsing / trimming / validating.
 *
 * Implementations MUST throw on transport failure or empty output so
 * the deterministic-fallback branch fires.
 */
export type GoldenLlmCaller = (args: {
  system: string;
  user: string;
}) => Promise<string>;

/**
 * Inputs every golden step needs. Threaded down from the orchestrator.
 */
export type GoldenStepContext = {
  /** Absolute venture root, e.g. /ventures/acme/. */
  ventureRoot: string;
  /** Mirrors VentureManifest.name. Always populated -- used in headlines. */
  ventureName: string;
  /** Mirrors VentureManifest.slug. */
  ventureSlug: string;
  /** From prepareBrandAssetsStep -- colours, fonts, logo paths. */
  brandTokens: BrandTokens;
  /** Clock for deterministic tests. */
  now: () => Date;
  /** Optional LLM caller. Omit for deterministic-only renders. */
  callLlm?: GoldenLlmCaller;
};

/**
 * Per-step output. The dispatcher folds these into contextOverrides
 * for the slice-5 renderAllStubsStep + collects diagnostics for the
 * runner's checkpoint notes.
 */
export type GoldenStepResult = {
  /** Descriptor.id this step targets. Used as the contextOverrides key. */
  docId: string;
  /** Placeholder -> rendered value. Must cover every placeholder the
   *  descriptor declares for status to come back as "generated". */
  placeholders: Record<string, string>;
  /** Sources the step actually read (relative paths from venture root). */
  sourcesRead: string[];
  /** True iff the LLM was successfully invoked. False = deterministic. */
  usedLlm: boolean;
  /** Diagnostic notes the orchestrator surfaces in the checkpoint. */
  notes: string[];
};

/** Function signature every Golden-16 step conforms to. */
export type GoldenStep = (ctx: GoldenStepContext) => Promise<GoldenStepResult>;

/**
 * The 16 doc IDs the Golden steps target. Sourced from the slice-1
 * DOC_MANIFEST filtered to tier=="A". Keeping this as a frozen list
 * here gives the dispatcher a stable iteration order independent of
 * manifest edits, and gives tests a single source of truth.
 *
 * NB the spec§6 sec 4 lists 15 docs ("Golden 15"); the manifest
 * authored in slice 1 declares 16 (`brand-guide` and `financial-model`
 * are Tier-A in the manifest but Tier-B in the spec). The manifest is
 * the ground truth -- slice 1 had final say on the inventory split.
 */
export const GOLDEN_DOC_IDS = [
  "company-brief",
  "market-research",
  "icp-personas",
  "prd",
  "mvp-scope",
  "user-stories",
  "brand-guide",
  "design-system",
  "wireframe-pack",
  "developer-brief",
  "technical-specification",
  "database-schema",
  "api-specification",
  "testing-strategy",
  "deployment-guide",
  "financial-model",
] as const;

export type GoldenDocId = (typeof GOLDEN_DOC_IDS)[number];
