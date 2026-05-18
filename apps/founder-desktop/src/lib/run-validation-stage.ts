/**
 * run-validation-stage.ts
 *
 * ValidationStageRunner adoption helper. Wraps the (now real)
 * ValidationStageRunner with the StageRunner contract -- preflight
 * validate, idempotent run, structured logs, optional review gate,
 * failed-runs bookkeeping.
 *
 * The runner is backed by createValidationSummaryStep, which turns
 * the founder\'s validation-canvas.json + 01_research/saas reports
 * into a stable go/no-go summary at:
 *   - 02_validation/validation-summary.json (machine-readable schema)
 *   - 02_validation/validation-summary.md   (founder-facing readout)
 *
 * LLM behaviour
 * -------------
 * The step LLM-enriches the markdown narrative when an LLM caller is
 * provided; otherwise it falls back to a deterministic templated
 * narrative. This helper resolves the active provider once via
 * buildPipelineLlmCaller. If the founder has no provider configured
 * we return { kind: "no-provider" } so the UI can surface a "configure
 * a provider for richer go/no-go" toast -- mirrors the research +
 * brand patterns. When a provider is present we forward the caller
 * into the runner, the abort signal fans out to any in-flight LLM
 * call, and the structured JSON shape stays identical.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, ValidationStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunValidationStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so the LLM
   * narrative call cancels when the user hits Stop. Has no effect on
   * the deterministic-narrative path.
   */
  signal?: AbortSignal;
  force?: boolean;
};

export type RunValidationStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      steps: { validation: "ok" | "missing" };
      /**
       * "llm" when the LLM caller produced the narrative, "deterministic"
       * when the helper ran without a provider, "deterministic-fallback"
       * if the provider call threw and we used the templated narrative.
       * Surfaced for toast copy ("Saved validation summary (LLM)").
       */
      summarySource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
    };

export async function runValidationStage(
  opts: RunValidationStageOpts
): Promise<RunValidationStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });
  // VALIDATION has a deterministic path -- the runner's step falls back
  // to a templated narrative when callLlm is undefined. Pass the caller
  // conditionally so the deterministic branch runs cleanly when no
  // provider is configured. The `kind: "no-provider"` variant is kept
  // in the return type for back-compat with callers, but is no longer
  // emitted by the helper.
  const runner = new ValidationStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    ...(llmCaller !== null ? { callLlm: llmCaller.callLlm } : {}),
  });
  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });
  const result = await orchestrator.runStage(runner, { force: opts.force ?? true });
  return {
    kind: "result",
    result,
    steps: deriveSteps(result.logs),
    summarySource: deriveSummarySource(result.logs),
  };
}

function deriveSteps(logs: LogEntry[]): { validation: "ok" | "missing" } {
  for (const e of logs)
    if (e.message === "validation checkpoint written") return { validation: "ok" };
  return { validation: "missing" };
}

/**
 * The runner emits a "validation checkpoint written" log entry whose
 * data payload includes summarySource. We pull it back out so the
 * caller can decide on toast copy without re-reading the JSON file.
 */
function deriveSummarySource(
  logs: LogEntry[]
): "llm" | "deterministic" | "deterministic-fallback" | "unknown" {
  for (const e of logs) {
    if (e.message !== "validation checkpoint written") continue;
    const ss = (e.data as Record<string, unknown> | undefined)?.summarySource;
    if (ss === "llm" || ss === "deterministic" || ss === "deterministic-fallback") {
      return ss;
    }
  }
  return "unknown";
}
