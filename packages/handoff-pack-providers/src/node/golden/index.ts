/**
 * Slice 6 -- @founder-os/handoff-pack-providers/node/golden barrel.
 *
 * Exports the 16 individual Golden steps, the shared types, and the
 * dispatcher. Re-exported from the package's /node entry point.
 */
export {
  dispatchGoldenSteps,
  GOLDEN_STEP_REGISTRY,
  type DispatchGoldenStepsOpts,
  type DispatchGoldenStepsResult,
} from "./dispatch.js";

export {
  GOLDEN_DOC_IDS,
  type GoldenDocId,
  type GoldenLlmCaller,
  type GoldenStep,
  type GoldenStepContext,
  type GoldenStepResult,
} from "./types.js";

export {
  createCompanyBriefStep,
  createMarketResearchStep,
  createIcpPersonasStep,
} from "./strategy.js";

export {
  createPrdStep,
  createMvpScopeStep,
  createUserStoriesStep,
} from "./product.js";

export {
  createBrandGuideStep,
  createDesignSystemStep,
  createWireframePackStep,
} from "./design.js";

export {
  createDeveloperBriefStep,
  createTechnicalSpecificationStep,
  createDatabaseSchemaStep,
  createApiSpecificationStep,
} from "./engineering.js";

export {
  createTestingStrategyStep,
  createDeploymentGuideStep,
  createFinancialModelStep,
} from "./ops.js";
