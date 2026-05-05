/**
 * run-brand-stage.ts
 *
 * Mirrors run-research-stage.ts but for the BRAND stage. Runs the
 * three-step naming -> brief -> logo chain via BrandStageRunner +
 * PipelineOrchestrator instead of calling the steps directly.
 *
 * What you gain over the per-button BrandTab handlers:
 *  - Preflight validate(): manifest.name + manifest.slug + LLM caller
 *    are all checked before any LLM call goes out.
 *  - Failed-runs bookkeeping (.founder/handoffs/failed/ + .founder/state/
 *    failed-runs.json) for any step that throws mid-chain.
 *  - Artifact index entries (.founder/artifacts/index.json) for every
 *    successful step, even if a later step blew up. Retries can
 *    resume because each step is internally skip-if-exists.
 *  - Stage-progress advancement -- BUT only after the BRAND review
 *    gate is approved, because BRAND is in DEFAULT_REVIEW_GATES (a
 *    name choice is irreversible-ish, so the founder approves before
 *    UK setup / finance / build treat the name as locked).
 *
 * BrandTab keeps its individual handlers (handleAiGenerateNames,
 * handleGenerateLogoPack, handleGenerateConcepts) for fine-grained
 * iteration. This helper is the "run the whole stage" entry point.
 *
 * Usage from BrandTab or VentureDashboard:
 *
 *   const out = await runBrandStage({ venture, manifest, seedHints });
 *   if (out.kind === "no-provider") { toast + bail to options }
 *   else { interpret out.result + out.counts }
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { BrandStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunBrandStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * Optional founder shortlist / "avoid these" hints, forwarded to the
   * naming step verbatim. Pulled from BrandTab's aiSeedHints state.
   */
  seedHints?: string;
  /**
   * How many naming candidates to ask the LLM for. Default 8 inside
   * the runner if omitted. The naming step's prompt asks for 5-10.
   */
  targetCount?: number;
  /**
   * Abort signal threaded through buildPipelineLlmCaller so all
   * in-flight LLM calls cancel together when the user hits Stop.
   */
  signal?: AbortSignal;
  /**
   * When true (default) bypass the orchestrator's "stage already
   * complete" short-circuit. Brand has internal skip-if-exists guards
   * at the step level (naming dedups, brief / logo no-op when files
   * exist), so re-running is safe and matches the existing UI
   * behaviour where clicking the button always tries the chain again.
   */
  force?: boolean;
};

export type RunBrandStageResult =
  | { kind: "no-provider" }
  | {
      kind: "result";
      result: StageRunResult;
      /**
       * Per-step status derived from the runner's log entries. Brand
       * emits one log per step ("naming step finished", "brand-brief
       * step finished", "logo-pack step finished") plus a starting
       * log; we parse the "finished" entries into the three flags so
       * the UI can show a per-step receipt.
       */
      steps: {
        naming: "ok" | "missing";
        brief: "ok" | "missing";
        logo: "ok" | "missing";
      };
    };

/**
 * Build + run the BRAND stage runner. See top-of-file docstring for
 * what this gets us versus calling the three steps directly.
 */
export async function runBrandStage(opts: RunBrandStageOpts): Promise<RunBrandStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    signal: opts.signal,
  });
  if (!llmCaller) return { kind: "no-provider" };

  const runner = new BrandStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    callLlm: llmCaller.callLlm,
    ...(opts.seedHints !== undefined ? { seedHints: opts.seedHints } : {}),
    ...(opts.targetCount !== undefined ? { targetCount: opts.targetCount } : {}),
  });

  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });

  const result = await orchestrator.runStage(runner, {
    force: opts.force ?? true,
  });

  return { kind: "result", result, steps: deriveSteps(result.logs) };
}

/**
 * Re-derive per-step status from the runner's log entries. Mirrors
 * the messages BrandStageRunner emits on success
 * (`naming step finished`, `brand-brief step finished`,
 * `logo-pack step finished`). If a step never finished -- because the
 * chain threw before reaching it -- its flag stays "missing".
 */
function deriveSteps(logs: LogEntry[]): {
  naming: "ok" | "missing";
  brief: "ok" | "missing";
  logo: "ok" | "missing";
} {
  let naming: "ok" | "missing" = "missing";
  let brief: "ok" | "missing" = "missing";
  let logo: "ok" | "missing" = "missing";
  for (const entry of logs) {
    if (entry.message === "naming step finished") naming = "ok";
    else if (entry.message === "brand-brief step finished") brief = "ok";
    else if (entry.message === "logo-pack step finished") logo = "ok";
  }
  return { naming, brief, logo };
}
