/**
 * run-stitch-stage.ts
 *
 * StitchStageRunner adoption helper. Wraps createStitchPackStep --
 * generates the design-AI handoff (Stitch / v0 / Figma Make prompts)
 * from the BrandBrief on disk. No LLM. Idempotent at the file level.
 *
 * Preconditions: 03_brand/brand-kit/brand-brief.json must exist
 * (written by BrandStageRunner). The runner's validate() surfaces
 * a clear error when missing; the desktop helper just forwards.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, StitchStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";

export type RunStitchStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  force?: boolean;
};

export type RunStitchStageResult = {
  result: StageRunResult;
  steps: { stitch: "ok" | "missing" };
};

export async function runStitchStage(opts: RunStitchStageOpts): Promise<RunStitchStageResult> {
  const runner = new StitchStageRunner({
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

function deriveSteps(logs: LogEntry[]): { stitch: "ok" | "missing" } {
  for (const e of logs) if (e.message === "create-stitch-pack finished") return { stitch: "ok" };
  return { stitch: "missing" };
}
