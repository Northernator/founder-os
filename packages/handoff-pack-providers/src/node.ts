/**
 * @founder-os/handoff-pack-providers/node -- Node-only entry point.
 *
 * Anything that needs node:fs / node:path lives here, NOT in the
 * root barrel ("./"). The Tauri WebView imports the root barrel only
 * -- this subpath would crash module evaluation in the renderer
 * (Vite externalises node:* into stubs that throw on access).
 * Mirrors @founder-os/media-providers, @founder-os/crm-providers,
 * @founder-os/handoff-providers, @founder-os/backend-providers,
 * @founder-os/social-providers.
 *
 * Typical Node startup (pipeline-runner / stage runner / CLI):
 *
 *   import {
 *     prepareBrandAssetsStep,
 *     renderPdfStep,
 *     createMinimalPdfEngine,
 *     createHtmlOnlyPdfEngine,
 *   } from "@founder-os/handoff-pack-providers/node";
 *
 * The WebView side ("@founder-os/handoff-pack-providers" root barrel)
 * gives you only the PdfEngine contract, the Handlebars-subset
 * template engine, the markdown converter, and the brand-CSS wrapper
 * -- everything that touches disk is here.
 */

// prepareBrandAssetsStep -- reads brand-brief + writes .brand/.
export {
  prepareBrandAssetsStep,
  projectBrandTokens,
  defaultPdfTemplateConfig,
  type PrepareBrandAssetsOpts,
} from "./node/prepare-brand-assets.js";

// renderPdfStep -- end-to-end markdown -> PDF per descriptor.
export {
  renderPdfStep,
  type RenderPdfStepOpts,
} from "./node/render-pdf.js";

// MinimalPdfEngine -- ships a real PDF binary without external deps.
export {
  createMinimalPdfEngine,
  type CreateMinimalPdfEngineOpts,
} from "./node/minimal-pdf-engine.js";

// HtmlOnlyPdfEngine -- writes branded HTML next to a stub PDF.
export {
  createHtmlOnlyPdfEngine,
  type CreateHtmlOnlyPdfEngineOpts,
} from "./node/html-only-pdf-engine.js";

// Re-export the client-safe surface so callers in Node can grab
// everything from "@founder-os/handoff-pack-providers/node" without
// juggling two imports.
export {
  PdfEngineIdSchema,
  PdfRenderResultSchema,
  HandoffPackBrandMissingError,
  HandoffPackRenderError,
  HandoffPackTemplateError,
  type PdfEngine,
  type PdfEngineId,
  type PdfEngineRenderInput,
  type PdfRenderResult,
  type PrepareBrandAssetsResult,
} from "./types.js";

export {
  renderTemplate,
  type TemplateContext,
  type TemplateRenderResult,
} from "./template-engine.js";

export { markdownToHtml } from "./markdown-engine.js";

export {
  buildBrandCss,
  wrapBrandedHtml,
  type WrapHtmlOpts,
} from "./css-template.js";

export {
  SLICE_2_PROOF_TEMPLATE,
  SLICE_2_PROOF_DESCRIPTOR,
} from "./proof-template.js";
// Slice 5 -- bulk worker + orchestrator the HandoffPackStageRunner calls.
export {
  renderAllStubsStep,
  type RenderAllStubsStepOpts,
  type RenderAllStubsStepResult,
} from "./node/render-all-stubs.js";
export {
  renderHandoffPackArtefactsStep,
  type RenderHandoffPackArtefactsOpts,
  type RenderHandoffPackArtefactsResult,
} from "./node/render-handoff-pack-artefacts.js";
export {
  renderBrandedPdfsStep,
  type RenderBrandedPdfsStepOpts,
  type RenderBrandedPdfsStepResult,
} from "./node/render-branded-pdfs.js";
export {
  renderRolePacksStep,
  type RenderRolePacksStepOpts,
  type RenderRolePacksStepResult,
} from "./node/render-role-packs.js";

// Re-export the pure INDEX.md builder so Node consumers (the runner)
// can grab it from the /node entry point without juggling two imports.
export {
  renderInventoryMarkdown,
  type RenderInventoryMarkdownOpts,
} from "./inventory-markdown.js";

// Slice 6 -- Golden-16 Tier-A render steps + dispatcher. Node-only
// because each step reads prior-stage artefacts off disk. The
// orchestrator (renderHandoffPackArtefactsStep) calls the dispatcher
// internally, but exposing the surface lets callers run an individual
// step (e.g. for diagnostics) or swap in custom registries.
export {
  dispatchGoldenSteps,
  GOLDEN_STEP_REGISTRY,
  GOLDEN_DOC_IDS,
  createCompanyBriefStep,
  createMarketResearchStep,
  createIcpPersonasStep,
  createPrdStep,
  createMvpScopeStep,
  createUserStoriesStep,
  createBrandGuideStep,
  createDesignSystemStep,
  createWireframePackStep,
  createDeveloperBriefStep,
  createTechnicalSpecificationStep,
  createDatabaseSchemaStep,
  createApiSpecificationStep,
  createTestingStrategyStep,
  createDeploymentGuideStep,
  createFinancialModelStep,
  type DispatchGoldenStepsOpts,
  type DispatchGoldenStepsResult,
  type GoldenDocId,
  type GoldenLlmCaller,
  type GoldenStep,
  type GoldenStepContext,
  type GoldenStepResult,
} from "./node/golden/index.js";

// Slice 7 -- Tier-B render steps + dispatcher. Same Node-only rationale
// as slice 6 (steps read prior-stage artefacts off disk). Mirror shape
// of the Golden surface so callers can fold both into the same merge.
export {
  dispatchTierBSteps,
  TIER_B_STEP_REGISTRY,
  TIER_B_DOC_IDS,
  createFounderVisionStep,
  createRiskRegisterStep,
  createBusinessPlanStep,
  createCompetitorAnalysisStep,
  createPricingStrategyStep,
  createBusinessModelCanvasStep,
  createPositioningStatementStep,
  createValuePropositionStep,
  createStrategicRoadmapStep,
  createUnitEconomicsModelStep,
  createInvestorDeckStep,
  createProductVisionStep,
  createUserFlowsStep,
  createProductRoadmapStep,
  createBrandStrategyStep,
  createLogoPackStep,
  createDesignHandoffStep,
  createArchitectureDiagramStep,
  createEnvironmentSetupGuideStep,
  createStartupBudgetStep,
  createCashflowForecastStep,
  createGoToMarketPlanStep,
  createSalesPlaybookStep,
  createBuyerPersonasStep,
  createCrmProcessStep,
  createWebsiteCopyStep,
  createLaunchPlanStep,
  type DispatchTierBStepsOpts,
  type DispatchTierBStepsResult,
  type TierBDocId,
} from "./node/tier-b/index.js";
