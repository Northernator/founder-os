/**
 * run-build-stage.ts
 *
 * BuildStageRunner adoption helper. Drops a build-handoff bundle
 * into the inbox at .founder/handoffs/inbox/<runId>.json. The VS
 * Code extension picks up the bundle async via the handoff watcher;
 * this runner does NOT wait for build completion.
 *
 * Practical implication: a successful run means "bundle dropped",
 * not "build complete". The desktop UI surfaces build progress
 * separately via the handoff watcher pipeline.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { BuildStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";

export type RunBuildStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  force?: boolean;
};

export type RunBuildStageResult = {
  result: StageRunResult;
  steps: { build: "ok" | "missing" };
};

export async function runBuildStage(opts: RunBuildStageOpts): Promise<RunBuildStageResult> {
  const runner = new BuildStageRunner({
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

function deriveSteps(logs: LogEntry[]): { build: "ok" | "missing" } {
  for (const e of logs) if (e.message === "create-build-handoff finished") return { build: "ok" };
  return { build: "missing" };
}
