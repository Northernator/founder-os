/**
 * run-research-stage.ts
 *
 * Adopts @founder-os/stage-runners' ResearchStageRunner +
 * PipelineOrchestrator in place of calling
 * createSaasResearchReportsStep directly.
 *
 * What you gain over the direct-call path:
 *   1. Preflight validate() — surfaces "manifest.appType !== 'saas'" or
 *      "no intake transcript" as a structured ValidationResult before
 *      any LLM call goes out.
 *   2. Idempotency short-circuit (when force=false): if stage-progress
 *      already shows RESEARCH complete, the orchestrator returns a
 *      synthetic success without invoking the runner. We default to
 *      force=true here to preserve the existing UI behavior where
 *      clicking Generate Reports always tries again — the underlying
 *      step is itself file-level idempotent (it skips reports whose
 *      .md already exists), so re-running is cheap and safe.
 *   3. Failed-runs bookkeeping: any failure dumps the full
 *      StageRunResult to .founder/handoffs/failed/ AND appends a slim
 *      entry to .founder/state/failed-runs.json that the desktop can
 *      list/retry without having to scan a directory.
 *   4. Artifact index: every report (written + skipped) lands as an
 *      ArtifactIndexEntry in .founder/artifacts/index.json under
 *      stageName=RESEARCH. The Artifacts tab can read this index
 *      instead of crawling the filesystem.
 *   5. Stage progress: a successful run advances
 *      .founder/state/stage-progress.json so downstream stages know
 *      RESEARCH is done. (Default config does NOT include RESEARCH in
 *      reviewGates, so the cursor advances immediately on success.)
 *
 * Usage from VentureDashboard (handleGenerateResearchReports):
 *
 *   const out = await runResearchStage({
 *     venture, manifest, intake, signal: controller.signal,
 *   });
 *   if (out.kind === "no-provider") { … toast … }
 *   else { interpret out.result … }
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { PipelineOrchestrator, ResearchStageRunner } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunResearchStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /** Concatenated chat transcript + ready-attachment blocks. */
  intake: string;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so all
   * parallel LLM calls cancel together when the user hits Stop.
   */
  signal?: AbortSignal;
  /**
   * When true (default) bypass the orchestrator's "stage already
   * complete" short-circuit. The underlying step is file-level
   * idempotent so re-running is safe and matches the existing UI
   * behavior. Pass false if you want the orchestrator to short-circuit
   * on completed stages.
   */
  force?: boolean;
};

export type RunResearchStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      /**
       * Per-report counts derived from the runner's log entries. The
       * runner emits one `wrote <filename>` / `skipped <filename>` /
       * `failed <filename>` log per report, so we can rebuild the
       * UI-friendly breakdown without breaking the StageRunResult
       * contract.
       */
      counts: { written: number; skipped: number; failed: number };
    };

/**
 * Build + run the RESEARCH stage runner. See top-of-file docstring
 * for what this gets us versus calling createSaasResearchReportsStep
 * directly.
 */
export async function runResearchStage(
  opts: RunResearchStageOpts
): Promise<RunResearchStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    signal: opts.signal,
    enableWebSearch: true,
    webSearchMaxUses: 5,
  });
  if (!llmCaller) return { kind: "no-provider" };

  const runner = new ResearchStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    intake: opts.intake,
    callLlm: llmCaller.callLlm,
  });

  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });

  const result = await orchestrator.runStage(runner, {
    // Default true: re-run every click. The step's own idempotent
    // file check still skips reports that already exist, so the LLM
    // cost is bounded to whatever's actually missing.
    force: opts.force ?? true,
  });

  return { kind: "result", result, counts: deriveCounts(result.logs) };
}

/**
 * Re-derive {written, skipped, failed} from the runner's per-report
 * log entries. Mirrors the strings the ResearchStageRunner emits
 * (`wrote <name>` / `skipped <name>` / `failed <name>`). If those
 * messages ever change, this helper drifts silently — there's a
 * smoke test in the runner's package that pins the message format.
 */
function deriveCounts(logs: LogEntry[]): {
  written: number;
  skipped: number;
  failed: number;
} {
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of logs) {
    if (entry.message.startsWith("wrote ")) written += 1;
    else if (entry.message.startsWith("skipped ")) skipped += 1;
    else if (entry.message.startsWith("failed ")) failed += 1;
  }
  return { written, skipped, failed };
}
