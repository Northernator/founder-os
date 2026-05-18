/**
 * Slice 7 -- @founder-os/handoff-pack-providers/node/tier-b barrel.
 *
 * Exports the 27 individual Tier-B steps, the shared types, and the
 * dispatcher. Re-exported from the package's /node entry point.
 */
export {
  dispatchTierBSteps,
  TIER_B_STEP_REGISTRY,
  type DispatchTierBStepsOpts,
  type DispatchTierBStepsResult,
} from "./dispatch.js";

export {
  TIER_B_DOC_IDS,
  type TierBDocId,
  type GoldenLlmCaller,
  type GoldenStep,
  type GoldenStepContext,
  type GoldenStepResult,
} from "./types.js";

export {
  createFounderVisionStep,
  createRiskRegisterStep,
} from "./company-control.js";

export {
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

export {
  createProductRoadmapStep,
  createProductVisionStep,
  createUserFlowsStep,
} from "./product.js";

export {
  createBrandStrategyStep,
  createDesignHandoffStep,
  createLogoPackStep,
} from "./design.js";

export {
  createArchitectureDiagramStep,
  createEnvironmentSetupGuideStep,
} from "./engineering.js";

export {
  createCashflowForecastStep,
  createStartupBudgetStep,
} from "./finance.js";

export {
  createBuyerPersonasStep,
  createCrmProcessStep,
  createGoToMarketPlanStep,
  createLaunchPlanStep,
  createSalesPlaybookStep,
  createWebsiteCopyStep,
} from "./sales-marketing.js";
