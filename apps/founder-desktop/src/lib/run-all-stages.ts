/**
 * run-all-stages.ts
 *
 * Sequentially runs the implemented stage runners against a venture
 * via the existing run-X-stage helpers. Stops at the first failure
 * or pending-review-gate. Already-complete stages short-circuit
 * (force=false) so the orchestrator's stage-progress check skips
 * them; subsequent re-runs of "Run all" only execute what's missing.
 *
 * Stages run in this order (preserves the original 7 positions and
 * slots the 4 skeletal runners at logically-prereqd points):
 *   1.  Research       (saas only -- skipped for non-saas appType)
 *   2.  Validation     (skeletal placeholder; deterministic)
 *   3.  Brand          (creates pending review gate by default; "Run
 *                       all" stops there until the founder approves)
 *   4.  Product        (deterministic; safe to chain)
 *   5.  Wireframe      (skeletal; needs screens-canvas.json from Product)
 *   6.  UkSetup        (deterministic)
 *   7.  Finance        (skeletal placeholder; deterministic)
 *   8.  Stitch         (skipped if brand-brief.json missing -- the
 *                       runner's validate() surfaces a clear error)
 *   9.  Audit          (deterministic)
 *   10. Build          (skipped if prereqs missing)
 *   11. Launch         (skeletal placeholder; deterministic)
 *
 * All 11 implemented stage runners are now covered. The 4 skeletal
 * placeholders just write small JSON checkpoints; they'll upgrade
 * in place when real pipeline-runner steps land.
 *
 * Abort: a passed AbortSignal aborts the current stage's LLM calls
 * (where applicable) and stops further iteration. The signal does
 * NOT prevent already-running synchronous code in a stage from
 * completing.
 */
import type { StageName, Venture, VentureManifest } from "@founder-os/domain";
import type { StageRunResult } from "@founder-os/stage-runners";
import { runAuditStage } from "./run-audit-stage.js";
import { runBrandStage } from "./run-brand-stage.js";
import { runBuildStage } from "./run-build-stage.js";
import { runFinanceStage } from "./run-finance-stage.js";
import { runLaunchStage } from "./run-launch-stage.js";
import { runProductStage } from "./run-product-stage.js";
import { runResearchStage } from "./run-research-stage.js";
import { runStitchStage } from "./run-stitch-stage.js";
import { runUkSetupStage } from "./run-uk-setup-stage.js";
import { runValidationStage } from "./run-validation-stage.js";
import { runWireframeStage } from "./run-wireframe-stage.js";

export type RunAllStagesOpts = {
  venture: Venture;
  manifest: VentureManifest;
  signal?: AbortSignal;
  /**
   * Concatenated chat transcript + attachment blocks for the
   * RESEARCH stage. Required when manifest.appType === "saas",
   * ignored otherwise. If omitted on a saas venture, RESEARCH is
   * skipped with reason "missing-intake".
   */
  intake?: string;
  /**
   * Fired before each stage starts. Lets the caller (the desktop
   * button) update UI to "Running RESEARCH...".
   */
  onStageStart?: (stage: StageName) => void;
  /**
   * Fired after each stage completes (success OR skip). The result
   * is null when the stage was skipped due to a precondition (e.g.
   * RESEARCH on a non-saas venture, or missing intake).
   */
  onStageEnd?: (stage: StageName, result: StageRunResult | null) => void;
};

export type StageOutcome =
  | { stage: StageName; status: "success"; result: StageRunResult }
  | { stage: StageName; status: "skipped"; reason: string }
  | { stage: StageName; status: "failure"; result: StageRunResult }
  | { stage: StageName; status: "review-needed"; result: StageRunResult }
  | { stage: StageName; status: "no-provider" }
  | { stage: StageName; status: "aborted" };

export type RunAllStagesResult = {
  outcomes: StageOutcome[];
  /**
   * Why iteration stopped. "completed" means the loop ran every
   * applicable stage; the others halt mid-loop.
   */
  stoppedBecause: "completed" | "failure" | "review-needed" | "no-provider" | "aborted";
};

const STAGE_ORDER: StageName[] = [
  "RESEARCH",
  "VALIDATION",
  "BRAND",
  "PRODUCT_SPEC",
  "WIREFRAME",
  "UK_SETUP",
  "FINANCE",
  "HANDOFF",
  "AUDIT",
  "BUILD",
  "LAUNCH",
];

/**
 * Run every implemented stage runner against the venture in order.
 * Stops at the first failure / pending review / no-provider / abort.
 *
 * The loop uses force=false on each helper so already-complete
 * stages short-circuit. To force a re-run, the user clicks the
 * per-stage button on the relevant tab (each helper's force prop
 * defaults to true on individual button clicks).
 */
export async function runAllStages(opts: RunAllStagesOpts): Promise<RunAllStagesResult> {
  const outcomes: StageOutcome[] = [];

  for (const stage of STAGE_ORDER) {
    if (opts.signal?.aborted) {
      outcomes.push({ stage, status: "aborted" });
      return { outcomes, stoppedBecause: "aborted" };
    }
    opts.onStageStart?.(stage);
    const outcome = await runOne(stage, opts);
    outcomes.push(outcome);
    opts.onStageEnd?.(stage, "result" in outcome ? outcome.result : null);
    if (outcome.status === "failure") {
      return { outcomes, stoppedBecause: "failure" };
    }
    if (outcome.status === "review-needed") {
      return { outcomes, stoppedBecause: "review-needed" };
    }
    if (outcome.status === "no-provider") {
      return { outcomes, stoppedBecause: "no-provider" };
    }
    if (outcome.status === "aborted") {
      return { outcomes, stoppedBecause: "aborted" };
    }
  }
  return { outcomes, stoppedBecause: "completed" };
}

/**
 * Dispatch one stage. Encapsulates per-stage helper invocation +
 * skip conditions + result interpretation.
 */
async function runOne(stage: StageName, opts: RunAllStagesOpts): Promise<StageOutcome> {
  const { venture, manifest } = opts;
  switch (stage) {
    case "RESEARCH": {
      if (manifest.appType !== "saas") {
        return { stage, status: "skipped", reason: "non-saas appType" };
      }
      if (!opts.intake?.trim()) {
        return { stage, status: "skipped", reason: "missing intake transcript" };
      }
      const out = await runResearchStage({
        venture,
        manifest,
        intake: opts.intake,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    case "BRAND": {
      const out = await runBrandStage({
        venture,
        manifest,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    case "PRODUCT_SPEC": {
      const out = await runProductStage({ venture, manifest, force: false });
      return interpret(stage, out.result);
    }
    case "UK_SETUP": {
      const out = await runUkSetupStage({ venture, manifest, force: false });
      return interpret(stage, out.result);
    }
    case "HANDOFF": {
      const out = await runStitchStage({ venture, manifest, force: false });
      return interpret(stage, out.result);
    }
    case "AUDIT": {
      const out = await runAuditStage({
        venture,
        manifest,
        ventureStage: venture.stage,
        force: false,
      });
      return interpret(stage, out.result);
    }
    case "BUILD": {
      const out = await runBuildStage({ venture, manifest, force: false });
      return interpret(stage, out.result);
    }
    case "VALIDATION": {
      const out = await runValidationStage({
        venture,
        manifest,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    case "WIREFRAME": {
      // Runner's validate() surfaces "run PRODUCT_SPEC stage first"
      // when screens-canvas.json is missing; the orchestrator returns
      // VALIDATION_FAILED and interpret() routes that to a "failure"
      // outcome, which stops the chain. That's the right behavior --
      // a Wireframe failure means upstream Product never landed.
      // The runner is now LLM-aware; surface "no-provider" the same
      // way RESEARCH/BRAND/VALIDATION do.
      const out = await runWireframeStage({
        venture,
        manifest,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    case "FINANCE": {
      const out = await runFinanceStage({
        venture,
        manifest,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    case "LAUNCH": {
      const out = await runLaunchStage({
        venture,
        manifest,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        force: false,
      });
      if (out.kind === "no-provider") return { stage, status: "no-provider" };
      return interpret(stage, out.result);
    }
    default:
      // Every StageName now has a case above. If a new stage is
      // added to @founder-os/domain without updating this switch,
      // fall back to a clearly-labeled skip rather than throwing.
      return { stage, status: "skipped", reason: "no UI helper yet" };
  }
}

function interpret(stage: StageName, result: StageRunResult): StageOutcome {
  if (!result.success) return { stage, status: "failure", result };
  if (result.requiresReview) return { stage, status: "review-needed", result };
  return { stage, status: "success", result };
}
