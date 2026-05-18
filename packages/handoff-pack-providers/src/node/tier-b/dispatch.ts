/**
 * Slice 7 -- Tier-B dispatcher.
 *
 * NODE-ONLY.
 *
 * Wires the 27 individual Tier-B createXxxStep functions into a single
 * call the slice-5 renderHandoffPackArtefactsStep can fold in. Returns
 * a contextOverrides record the slice-5 renderAllStubsStep already
 * consumes via opts.contextOverrides, plus diagnostics for the
 * checkpoint.
 *
 * Mirror image of golden/dispatch.ts -- same shape, same concurrency
 * (Promise.allSettled), same partial-failure tolerance. The two
 * dispatchers run sequentially in the orchestrator so a future race
 * over fs reads stays predictable.
 */
import {
  createFounderVisionStep,
  createRiskRegisterStep,
} from "./company-control.js";
import {
  createBusinessPlanStep,
  createBusinessModelCanvasStep,
  createCompetitorAnalysisStep,
  createInvestorDeckStep,
  createPositioningStatementStep,
  createPricingStrategyStep,
  createStrategicRoadmapStep,
  createUnitEconomicsModelStep,
  createValuePropositionStep,
} from "./strategy.js";
import {
  createProductRoadmapStep,
  createProductVisionStep,
  createUserFlowsStep,
} from "./product.js";
import {
  createBrandStrategyStep,
  createDesignHandoffStep,
  createLogoPackStep,
} from "./design.js";
import {
  createArchitectureDiagramStep,
  createEnvironmentSetupGuideStep,
} from "./engineering.js";
import {
  createCashflowForecastStep,
  createStartupBudgetStep,
} from "./finance.js";
import {
  createBuyerPersonasStep,
  createCrmProcessStep,
  createGoToMarketPlanStep,
  createLaunchPlanStep,
  createSalesPlaybookStep,
  createWebsiteCopyStep,
} from "./sales-marketing.js";
import {
  TIER_B_DOC_IDS,
  type GoldenStep,
  type GoldenStepContext,
  type GoldenStepResult,
} from "./types.js";

/**
 * Ordered registry of the 27 Tier-B steps. ORDER MATTERS for
 * deterministic test output -- the dispatcher iterates this list to
 * produce notes. The mapping is intentionally pinned to TIER_B_DOC_IDS
 * so a manifest reshuffle surfaces as a TypeScript error rather than a
 * silent ordering drift.
 */
const TIER_B_REGISTRY: ReadonlyArray<{ docId: (typeof TIER_B_DOC_IDS)[number]; step: GoldenStep }> = [
  // 00-company-control
  { docId: "founder-vision", step: createFounderVisionStep },
  { docId: "risk-register", step: createRiskRegisterStep },
  // 01-strategy
  { docId: "business-plan", step: createBusinessPlanStep },
  { docId: "competitor-analysis", step: createCompetitorAnalysisStep },
  { docId: "pricing-strategy", step: createPricingStrategyStep },
  { docId: "business-model-canvas", step: createBusinessModelCanvasStep },
  { docId: "positioning-statement", step: createPositioningStatementStep },
  { docId: "value-proposition", step: createValuePropositionStep },
  { docId: "strategic-roadmap", step: createStrategicRoadmapStep },
  { docId: "unit-economics-model", step: createUnitEconomicsModelStep },
  { docId: "investor-deck", step: createInvestorDeckStep },
  // 02-product
  { docId: "product-vision", step: createProductVisionStep },
  { docId: "user-flows", step: createUserFlowsStep },
  { docId: "product-roadmap", step: createProductRoadmapStep },
  // 03-design-brand
  { docId: "brand-strategy", step: createBrandStrategyStep },
  { docId: "logo-pack", step: createLogoPackStep },
  { docId: "design-handoff", step: createDesignHandoffStep },
  // 04-engineering
  { docId: "architecture-diagram", step: createArchitectureDiagramStep },
  { docId: "environment-setup-guide", step: createEnvironmentSetupGuideStep },
  // 07-finance-admin
  { docId: "startup-budget", step: createStartupBudgetStep },
  { docId: "cashflow-forecast", step: createCashflowForecastStep },
  // 08-sales-marketing
  { docId: "go-to-market-plan", step: createGoToMarketPlanStep },
  { docId: "sales-playbook", step: createSalesPlaybookStep },
  { docId: "buyer-personas", step: createBuyerPersonasStep },
  { docId: "crm-process", step: createCrmProcessStep },
  { docId: "website-copy", step: createWebsiteCopyStep },
  { docId: "launch-plan", step: createLaunchPlanStep },
];

export type DispatchTierBStepsOpts = GoldenStepContext;

export type DispatchTierBStepsResult = {
  /** Per-doc placeholder overrides. Keyed by descriptor.id. Slice-5's
   *  renderAllStubsStep accepts this shape via contextOverrides. */
  contextOverrides: Record<string, Record<string, string>>;
  /** All per-step results, preserved for diagnostic dumps. */
  results: GoldenStepResult[];
  /** Counts the orchestrator surfaces in the checkpoint envelope. */
  counts: {
    /** Steps that completed (deterministic OR LLM). */
    completed: number;
    /** Subset of completed that actually used the LLM. */
    usedLlm: number;
    /** Subset that fell back to deterministic (caller-supplied LLM but it threw). */
    deterministicFallback: number;
    /** Steps that threw before producing a result. */
    failed: number;
  };
  /** Aggregated notes from every step + per-step failures. */
  notes: string[];
};

/**
 * Run all 27 Tier-B steps. Idempotent + safe to call without an LLM
 * (each step degrades to deterministic placeholders).
 */
export async function dispatchTierBSteps(
  opts: DispatchTierBStepsOpts
): Promise<DispatchTierBStepsResult> {
  const settled = await Promise.allSettled(
    TIER_B_REGISTRY.map((entry) => entry.step(opts))
  );

  const contextOverrides: Record<string, Record<string, string>> = {};
  const results: GoldenStepResult[] = [];
  const notes: string[] = [];
  let completed = 0;
  let usedLlm = 0;
  let deterministicFallback = 0;
  let failed = 0;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const entry = TIER_B_REGISTRY[i];
    if (outcome === undefined || entry === undefined) continue;
    const docId = entry.docId;
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      contextOverrides[result.docId] = result.placeholders;
      results.push(result);
      notes.push(...result.notes);
      completed++;
      if (result.usedLlm) {
        usedLlm++;
      } else if (opts.callLlm) {
        // Caller supplied an LLM but the step ended up deterministic --
        // surface this so the founder can see which docs fell back.
        // Tier-B has 15 docs that NEVER call the LLM by design (pure
        // renders); those should NOT count as fallback. We detect the
        // intent via the step's sourcesRead -- LLM-enabled steps that
        // fall back add an explicit "LLM failed" note. So we count
        // fallback iff any note in the result starts with this docId
        // and includes "LLM failed".
        const failedLlm = result.notes.some(
          (n) => n.startsWith(`${docId}:`) && n.includes("LLM failed")
        );
        if (failedLlm) deterministicFallback++;
      }
    } else {
      failed++;
      const reason: unknown = outcome.reason;
      const m = reason instanceof Error ? reason.message : String(reason);
      notes.push(`tier-b:${docId} threw -- ${m}`);
    }
  }

  return {
    contextOverrides,
    results,
    counts: { completed, usedLlm, deterministicFallback, failed },
    notes,
  };
}

// Re-export the registry for tests + introspection. Frozen to avoid
// accidental mutation.
export const TIER_B_STEP_REGISTRY = Object.freeze(TIER_B_REGISTRY);
