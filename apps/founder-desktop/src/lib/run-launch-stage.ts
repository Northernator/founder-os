/**
 * run-launch-stage.ts
 *
 * LaunchStageRunner adoption helper. Wraps the (now real)
 * LaunchStageRunner with the StageRunner contract -- preflight
 * validate, idempotent run, structured logs, optional review gate,
 * failed-runs bookkeeping.
 *
 * The runner is backed by createLaunchPackageStep, which synthesises
 * every upstream artifact (brand brief, validation summary, finance
 * plan, UK setup, build handoff) into:
 *   - 08_launch/launch-receipt.json    (machine-readable + checklist)
 *   - 08_launch/launch-announcement.md (founder-facing announcement)
 *
 * LLM behaviour
 * -------------
 * The announcement markdown is LLM-written when an LLM caller is
 * provided; otherwise a deterministic templated announcement is
 * rendered. This helper resolves the active provider once via
 * buildPipelineLlmCaller. If no provider is configured we return
 * { kind: "no-provider" } so the UI can surface a "configure a
 * provider for richer launch copy" toast.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { LaunchStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunLaunchStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so the
   * announcement LLM call cancels when the user hits Stop.
   */
  signal?: AbortSignal;
  force?: boolean;
};

export type RunLaunchStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      steps: { launch: "ok" | "missing" };
      /**
       * Pre-launch checklist outcome rolled up from the receipt:
       * "ready-to-launch" / "checkpoint" / "needs-attention" /
       * "unknown". Surfaced for toast copy + UI gating.
       */
      receiptStatus:
        | "ready-to-launch"
        | "checkpoint"
        | "needs-attention"
        | "unknown";
      generationSource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
    };

export async function runLaunchStage(opts: RunLaunchStageOpts): Promise<RunLaunchStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });
  // LAUNCH has a deterministic path -- runner falls back to a
  // templated announcement when callLlm is undefined. The
  // `kind: "no-provider"` variant is kept in the return type for
  // back-compat but no longer emitted by the helper.
  const runner = new LaunchStageRunner({
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
  const result = await orchestrator.runStage(runner, { force: opts.force ?? true });
  return {
    kind: "result",
    result,
    steps: deriveSteps(result.logs),
    receiptStatus: deriveReceiptStatus(result.logs),
    generationSource: deriveGenerationSource(result.logs),
  };
}

function deriveSteps(logs: LogEntry[]): { launch: "ok" | "missing" } {
  for (const e of logs) if (e.message === "launch receipt written") return { launch: "ok" };
  return { launch: "missing" };
}

function deriveReceiptStatus(
  logs: LogEntry[]
): "ready-to-launch" | "checkpoint" | "needs-attention" | "unknown" {
  for (const e of logs) {
    if (e.message !== "launch receipt written") continue;
    const rs = (e.data as Record<string, unknown> | undefined)?.receiptStatus;
    if (rs === "ready-to-launch" || rs === "checkpoint" || rs === "needs-attention") {
      return rs;
    }
  }
  return "unknown";
}

function deriveGenerationSource(
  logs: LogEntry[]
): "llm" | "deterministic" | "deterministic-fallback" | "unknown" {
  for (const e of logs) {
    if (e.message !== "launch receipt written") continue;
    const gs = (e.data as Record<string, unknown> | undefined)?.generationSource;
    if (gs === "llm" || gs === "deterministic" || gs === "deterministic-fallback") {
      return gs;
    }
  }
  return "unknown";
}
