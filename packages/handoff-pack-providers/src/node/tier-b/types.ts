/**
 * Slice 7 -- shared types for the Tier-B "extended ~27" render steps.
 *
 * NODE-ONLY. Lives behind the /node entry point because each
 * createXxxStep reads prior-stage artefacts off disk.
 *
 * Slice 7 promotes the HANDOFF_PACK orchestrator from "Tier-A LLM
 * enriched + Tier-B/C/D stubs" to "Tier-A LLM enriched + Tier-B LLM
 * enriched (lower fidelity) + Tier-C/D stubs".
 *
 * The contract is identical to slice 6's Golden 16 -- step function
 * signature, context shape, result envelope, deterministic-fallback
 * semantics. The differences are:
 *
 *   - lower-fidelity LLM prompts (shorter, more deterministic defaults)
 *   - more steps render deterministically without an LLM at all
 *     (logo-pack, design-handoff, environment-setup-guide, user-flows,
 *      product-roadmap, strategic-roadmap, unit-economics-model,
 *      startup-budget, cashflow-forecast, architecture-diagram,
 *      competitor-analysis, crm-process, launch-plan, sales-playbook,
 *      logo-pack) -- 15 of the 27 are pure-render, 12 are LLM-enabled
 *   - the dispatcher emits a separate `tierB` envelope on the
 *     orchestrator result so the runner can surface the two counters
 *     independently in the checkpoint
 *
 * Slice 6's GoldenStep / GoldenStepContext / GoldenStepResult types are
 * reused verbatim -- the per-step contract has no namespace requirement.
 * Only the doc-ID enumeration is Tier-B specific.
 */
import type {
  GoldenLlmCaller,
  GoldenStep,
  GoldenStepContext,
  GoldenStepResult,
} from "../golden/types.js";

// Re-export so callers can grab everything from "./tier-b/types.js"
// without juggling two import paths. Slice 7's dispatcher signature
// matches slice 6's exactly aside from the registry contents.
export type {
  GoldenLlmCaller,
  GoldenStep,
  GoldenStepContext,
  GoldenStepResult,
};

/**
 * The 27 Tier-B doc IDs. Sourced from the slice-1 DOC_MANIFEST filtered
 * to tier=="B". Keeping this as a frozen list here gives the dispatcher
 * a stable iteration order independent of manifest edits, and gives
 * tests a single source of truth.
 *
 * Order: manifest order (alphabetical within category, category order
 * 00 -> 08). Tests assert this order matches the registry order so a
 * manifest reshuffle surfaces as a test failure rather than silent
 * drift.
 *
 * NB the spec sec 4 says "~30 more docs"; the manifest declares 27
 * (slice-1 author's call). The manifest is the ground truth -- same
 * precedent as slice 6 (spec said 15, manifest 16).
 */
export const TIER_B_DOC_IDS = [
  // 00-company-control
  "founder-vision",
  "risk-register",
  // 01-strategy
  "business-plan",
  "competitor-analysis",
  "pricing-strategy",
  "business-model-canvas",
  "positioning-statement",
  "value-proposition",
  "strategic-roadmap",
  "unit-economics-model",
  "investor-deck",
  // 02-product
  "product-vision",
  "user-flows",
  "product-roadmap",
  // 03-design-brand
  "brand-strategy",
  "logo-pack",
  "design-handoff",
  // 04-engineering
  "architecture-diagram",
  "environment-setup-guide",
  // 07-finance-admin
  "startup-budget",
  "cashflow-forecast",
  // 08-sales-marketing
  "go-to-market-plan",
  "sales-playbook",
  "buyer-personas",
  "crm-process",
  "website-copy",
  "launch-plan",
] as const;

export type TierBDocId = (typeof TIER_B_DOC_IDS)[number];
