/**
 * run-uk-setup-stage.ts
 *
 * UkSetupStageRunner adoption helper. Wraps ensureUkSetupStep with
 * the StageRunner contract (preflight validate, idempotent run,
 * structured logs, optional review gate, failed-runs bookkeeping).
 *
 * Mirrors run-product-stage.ts -- no LLM, no abort signal, no
 * "no-provider" branch. The runner only ensures the canvas file
 * exists with sensible defaults; the founder fills it in
 * interactively in UkSetupTab afterward.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, UkSetupStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";

export type RunUkSetupStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  force?: boolean;
};

export type RunUkSetupStageResult = {
  result: StageRunResult;
  steps: { setup: "ok" | "missing" };
};

export async function runUkSetupStage(opts: RunUkSetupStageOpts): Promise<RunUkSetupStageResult> {
  const runner = new UkSetupStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });
  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });
  const result = await orchestrator.runStage(runner, { force: opts.force ?? true });
  return { result, steps: deriveSteps(result.logs) };
}

function deriveSteps(logs: LogEntry[]): { setup: "ok" | "missing" } {
  for (const e of logs) if (e.message === "ensure-uk-setup finished") return { setup: "ok" };
  return { setup: "missing" };
}
