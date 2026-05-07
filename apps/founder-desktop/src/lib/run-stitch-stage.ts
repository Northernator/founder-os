/**
 * run-stitch-stage.ts
 *
 * HANDOFF stage adoption helper (kept under the "stitch" filename for
 * back-compat with ScreensTab and any other call-site that imports
 * `runStitchStage` -- slice 5/6 of the dual-handoff arc).
 *
 * Wraps HandoffStageRunner (exported from stage-runners as
 * StitchStageRunner alias). The runner reads
 * manifest.handoffSource ("stitch" | "codesign") and dispatches to
 * createStitchPackStep or createCodesignPackStep accordingly. This
 * helper doesn't need to know which provider ran -- it just inspects
 * the resulting logs.
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
  // The "stitch" key is kept for back-compat with ScreensTab. Reads
  // "ok" when EITHER provider's finished-log appeared, so the
  // success-toast still fires whether the venture ran Stitch or
  // CoDesign.
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

// Either provider's finished-log counts as success. The exact strings
// are pinned by the log-strings drift test in
// packages/stage-runners/test/log-strings.test.ts so a silent rename
// in the runner / step would fail CI.
const HANDOFF_SUCCESS_LOGS = new Set([
  "create-stitch-pack finished",
  "create-codesign-pack finished",
]);

function deriveSteps(logs: LogEntry[]): { stitch: "ok" | "missing" } {
  for (const e of logs) if (HANDOFF_SUCCESS_LOGS.has(e.message)) return { stitch: "ok" };
  return { stitch: "missing" };
}
