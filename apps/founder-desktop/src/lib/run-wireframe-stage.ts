/**
 * run-wireframe-stage.ts
 *
 * WireframeStageRunner adoption helper. Wraps the (now real)
 * WireframeStageRunner with the StageRunner contract -- preflight
 * validate, idempotent run, structured logs, optional review gate,
 * failed-runs bookkeeping.
 *
 * The runner is backed by createWireframesStep, which turns the
 * screens-canvas + spec-canvas into per-screen wireframe specs at:
 *   - 06_product/wireframes/wireframe-checkpoint.json (machine-readable schema)
 *   - 06_product/wireframes/wireframes.md             (founder-facing readout)
 *
 * Prereq: 06_product/wireframes/screens-canvas.json must exist
 * (written by ProductStageRunner). When missing, the orchestrator
 * returns a VALIDATION_FAILED error with a "run PRODUCT_SPEC stage
 * first" message that the desktop\'s <FailedRunBanner> surfaces
 * unchanged.
 *
 * LLM behaviour
 * -------------
 * Each screen\'s "Layout & states" narrative is LLM-written when an
 * LLM caller is provided; otherwise a deterministic narrative keyed
 * off shellType is used. This helper resolves the active provider
 * once via buildPipelineLlmCaller. If the founder has no provider
 * configured we return { kind: "no-provider" } so the UI can surface
 * a "configure a provider for richer wireframes" toast -- mirrors
 * the research / brand / validation patterns. When a provider is
 * present we forward the caller into the runner; the abort signal
 * fans out to every per-screen LLM call.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, WireframeStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunWireframeStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so the per-
   * screen LLM calls cancel together when the user hits Stop. Has no
   * effect on the deterministic-narrative path.
   */
  signal?: AbortSignal;
  force?: boolean;
};

export type RunWireframeStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      steps: { wireframe: "ok" | "missing" };
      /**
       * "llm" when every screen\'s narrative came from the LLM,
       * "deterministic" when no provider, "deterministic-fallback"
       * when at least one LLM call failed and was replaced by the
       * templated narrative. Surfaced for toast copy ("Saved
       * wireframes (LLM)").
       */
      generationSource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
    };

export async function runWireframeStage(
  opts: RunWireframeStageOpts
): Promise<RunWireframeStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });
  if (!llmCaller) return { kind: "no-provider" };

  const runner = new WireframeStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    callLlm: llmCaller.callLlm,
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
    generationSource: deriveGenerationSource(result.logs),
  };
}

function deriveSteps(logs: LogEntry[]): { wireframe: "ok" | "missing" } {
  for (const e of logs)
    if (e.message === "wireframe checkpoint written") return { wireframe: "ok" };
  return { wireframe: "missing" };
}

/**
 * The runner emits a "wireframe checkpoint written" log entry whose
 * data payload includes generationSource. We pull it back out so the
 * caller can decide on toast copy without re-reading the JSON file.
 */
function deriveGenerationSource(
  logs: LogEntry[]
): "llm" | "deterministic" | "deterministic-fallback" | "unknown" {
  for (const e of logs) {
    if (e.message !== "wireframe checkpoint written") continue;
    const gs = (e.data as Record<string, unknown> | undefined)?.generationSource;
    if (gs === "llm" || gs === "deterministic" || gs === "deterministic-fallback") {
      return gs;
    }
  }
  return "unknown";
}
