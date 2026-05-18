/**
 * run-product-stage.ts
 *
 * Mirror of run-research-stage.ts and run-brand-stage.ts but for the
 * PRODUCT_SPEC stage. Runs the deterministic three-step chain
 * ensureBrief -> ensureSpec -> ensureScreens through ProductStageRunner
 * + PipelineOrchestrator instead of having SpecTab / ScreensTab call
 * the steps directly.
 *
 * Differences from the LLM-driven helpers:
 *  - No buildPipelineLlmCaller call -- ProductStageRunner takes no
 *    callLlm because all three steps are deterministic. The "no
 *    provider configured" branch other helpers carry is dropped.
 *  - The runner has no signal hook -- nothing to abort. We accept an
 *    abort signal in the opts for symmetry but don't wire it through;
 *    a deterministic spec + screens generation is fast enough that
 *    cancellation isn't worth the plumbing.
 *
 * What you gain over the existing tabs' direct file IO:
 *  - Preflight validate(): manifest.id / .name / .appType all checked.
 *  - Failed-runs bookkeeping (.founder/state/failed-runs.json +
 *    .founder/handoffs/failed/PRODUCT_SPEC-<run>.result.json).
 *  - Artifact index entries for dev-brief, spec-canvas + spec.md,
 *    screens-canvas + screens.md.
 *  - Stage-progress advancement on success (PRODUCT_SPEC is NOT in
 *    DEFAULT_REVIEW_GATES so the cursor advances immediately).
 *
 * Both SpecTab and ScreensTab can call this helper -- they share the
 * same PRODUCT_SPEC stage so a successful run from either tab clears
 * any prior failed-runs index entry for the other.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, ProductStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunProductStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * When true (default) bypass the orchestrator's "stage already
   * complete" short-circuit. All three product steps are file-level
   * idempotent (each early-returns "skipped" if its target file
   * exists), so re-running is safe and matches the existing UI
   * behaviour where clicking the button always tries the chain.
   */
  force?: boolean;
};

export type RunProductStageResult = {
  result: StageRunResult;
  /**
   * Per-step status derived from the runner's log entries. The runner
   * emits "ensure-brief finished", "ensure-spec finished", and
   * "ensure-screens finished" on success. If a step never finished
   * because the chain threw before reaching it, that flag stays
   * "missing".
   */
  steps: {
    brief: "ok" | "missing";
    spec: "ok" | "missing";
    screens: "ok" | "missing";
  };
};

/**
 * Build + run the PRODUCT_SPEC stage runner. See top-of-file
 * docstring for what this gets us versus calling the three steps
 * directly. Note this helper does NOT have a "no-provider" return
 * branch -- ProductStageRunner is LLM-free.
 */
export async function runProductStage(opts: RunProductStageOpts): Promise<RunProductStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    enableWebSearch: false,
  });
  const runner = new ProductStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    enableDeepResearch: llmCaller !== null,
    ...(llmCaller !== null ? { callLlm: llmCaller.callLlm } : {}),
  });

  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });

  const result = await orchestrator.runStage(runner, {
    force: opts.force ?? true,
  });

  return { result, steps: deriveSteps(result.logs) };
}

/**
 * Re-derive per-step status from the runner's log entries. Mirrors
 * the messages ProductStageRunner emits on success
 * ("ensure-brief finished" / "ensure-spec finished" /
 * "ensure-screens finished"). Drift-prone -- a runner change to log
 * strings would silently break the UI receipt. A smoke test in the
 * stage-runners package would pin these eventually.
 */
function deriveSteps(logs: LogEntry[]): {
  brief: "ok" | "missing";
  spec: "ok" | "missing";
  screens: "ok" | "missing";
} {
  let brief: "ok" | "missing" = "missing";
  let spec: "ok" | "missing" = "missing";
  let screens: "ok" | "missing" = "missing";
  for (const entry of logs) {
    if (entry.message === "ensure-brief finished") brief = "ok";
    else if (entry.message === "ensure-spec finished") spec = "ok";
    else if (entry.message === "ensure-screens finished") screens = "ok";
  }
  return { brief, spec, screens };
}
