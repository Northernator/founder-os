/**
 * run-finance-stage.ts
 *
 * FinanceStageRunner adoption helper. Wraps the (now real)
 * FinanceStageRunner with the StageRunner contract -- preflight
 * validate, idempotent run, structured logs, optional review gate,
 * failed-runs bookkeeping.
 *
 * The runner is backed by createFinancePlanStep, which produces:
 *   - 05_finance/finance-canvas.json (founder-editable; skip-if-exists)
 *   - 05_finance/finance-plan.json   (computed forecast; always rewritten)
 *   - 05_finance/finance-plan.md     (founder-facing readout; always rewritten)
 *
 * LLM behaviour
 * -------------
 * The plan\'s "Strategic narrative" markdown section is LLM-written
 * when an LLM caller is provided; otherwise a deterministic
 * templated narrative is used. This helper resolves the active
 * provider once via buildPipelineLlmCaller. If the founder has no
 * provider configured we return { kind: "no-provider" } so the UI
 * can surface a "configure a provider for richer narratives" toast
 * -- mirrors the research / brand / validation / wireframe patterns.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { FinanceStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunFinanceStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so the
   * narrative LLM call cancels when the user hits Stop. Has no
   * effect on the deterministic-narrative path.
   */
  signal?: AbortSignal;
  force?: boolean;
};

export type RunFinanceStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      steps: { finance: "ok" | "missing" };
      /**
       * "scaffolded" if the canvas was freshly written, "preserved"
       * if it already existed. Surfaced for toast copy ("Saved
       * finance plan (canvas preserved)").
       */
      canvasStatus: "scaffolded" | "preserved" | "unknown";
      /**
       * "llm" / "deterministic" / "deterministic-fallback" -- where
       * the strategic narrative came from. Surfaced for toast copy.
       */
      generationSource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
    };

export async function runFinanceStage(
  opts: RunFinanceStageOpts
): Promise<RunFinanceStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });
  // FINANCE has a deterministic path -- runner falls back to the
  // templated strategic narrative when callLlm is undefined. The
  // `kind: "no-provider"` variant is kept in the return type for
  // back-compat but no longer emitted by the helper.
  const runner = new FinanceStageRunner({
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
    canvasStatus: deriveCanvasStatus(result.logs),
    generationSource: deriveGenerationSource(result.logs),
  };
}

function deriveSteps(logs: LogEntry[]): { finance: "ok" | "missing" } {
  for (const e of logs)
    if (e.message === "ensure-finance-canvas finished") return { finance: "ok" };
  return { finance: "missing" };
}

function deriveCanvasStatus(logs: LogEntry[]): "scaffolded" | "preserved" | "unknown" {
  for (const e of logs) {
    if (e.message !== "ensure-finance-canvas finished") continue;
    const cs = (e.data as Record<string, unknown> | undefined)?.canvasStatus;
    if (cs === "scaffolded" || cs === "preserved") return cs;
  }
  return "unknown";
}

function deriveGenerationSource(
  logs: LogEntry[]
): "llm" | "deterministic" | "deterministic-fallback" | "unknown" {
  for (const e of logs) {
    if (e.message !== "ensure-finance-canvas finished") continue;
    const gs = (e.data as Record<string, unknown> | undefined)?.generationSource;
    if (gs === "llm" || gs === "deterministic" || gs === "deterministic-fallback") {
      return gs;
    }
  }
  return "unknown";
}
