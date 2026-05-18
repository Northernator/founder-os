/**
 * @founder-os/stage-runners
 *
 * Modular per-stage execution runtime for the Founder OS pipeline.
 * Wraps the existing step modules in @founder-os/pipeline-runner with
 * a uniform StageRunner contract: preflight validation, idempotent
 * run, structured logs, optional human review gate.
 *
 * Status (post-2026-05-17 sweep):
 *   shipped: ResearchStageRunner, BrandStageRunner, ProductStageRunner,
 *            UkSetupStageRunner, AuditStageRunner, StitchStageRunner /
 *            HandoffStageRunner, BuildStageRunner, ValidationStageRunner,
 *            WireframeStageRunner, FinanceStageRunner, LaunchStageRunner,
 *            MediaStageRunner, MediaEditStageRunner, CrmStageRunner,
 *            BackendStageRunner, HandoffPackStageRunner.
 *   note:    HandoffPackStageRunner promoted skeletal -> real in slice 5
 *            of the handoff-pack arc. It orchestrates
 *            renderHandoffPackArtefactsStep from
 *            @founder-os/handoff-pack-providers/node:
 *            prepareBrandAssetsStep + renderAllStubsStep + writeInventory
 *            (markdown + JSON). Role-pack assembly lands in slice 10;
 *            tier A/B LLM enrichment lands in slices 6 + 7; per-stage
 *            progressive PDFs in slices 8 + 9. The runner contract is
 *            unchanged from the skeletal placeholder.
 *
 * See uploads/moneyprinter_quick_reference.md for design rationale.
 */
export * from "./types.js";
export { BaseStageRunner, generateRunId } from "./runner-base.js";
export { ResearchStageRunner, type ResearchStageRunnerOpts } from "./runners/research-runner.js";
export { BrandStageRunner, type BrandStageRunnerOpts } from "./runners/brand-runner.js";
export { ProductStageRunner, type ProductStageRunnerOpts } from "./runners/product-runner.js";
export { UkSetupStageRunner, type UkSetupStageRunnerOpts } from "./runners/uk-setup-runner.js";
export { AuditStageRunner, type AuditStageRunnerOpts } from "./runners/audit-runner.js";
export {
  HandoffStageRunner,
  type HandoffStageRunnerOpts,
} from "./runners/handoff-runner.js";
// Back-compat alias for the pre-slice-5 name. Existing consumers
// (apps/founder-desktop/src/lib/run-stitch-stage.ts, log-strings test)
// continue to work; new code should import HandoffStageRunner.
export {
  HandoffStageRunner as StitchStageRunner,
  type HandoffStageRunnerOpts as StitchStageRunnerOpts,
} from "./runners/handoff-runner.js";
export { BuildStageRunner, type BuildStageRunnerOpts } from "./runners/build-runner.js";
export {
  ValidationStageRunner,
  type ValidationStageRunnerOpts,
} from "./runners/validation-runner.js";
export {
  WireframeStageRunner,
  type WireframeStageRunnerOpts,
} from "./runners/wireframe-runner.js";
export {
  FinanceStageRunner,
  type FinanceStageRunnerOpts,
} from "./runners/finance-runner.js";
export { LaunchStageRunner, type LaunchStageRunnerOpts } from "./runners/launch-runner.js";
export {
  MediaStageRunner,
  type MediaStageRunnerOpts,
} from "./runners/media-runner.js";
export {
  MediaEditStageRunner,
  type MediaEditStageRunnerOpts,
} from "./runners/media-edit-runner.js";
export {
  CrmStageRunner,
  type CrmStageRunnerOpts,
} from "./runners/crm-runner.js";
export {
  BackendStageRunner,
  type BackendStageRunnerOpts,
} from "./runners/backend-runner.js";
export {
  PipelineOrchestrator,
  type PipelineOrchestratorOpts,
  type RunStageOpts,
} from "./orchestrator.js";
