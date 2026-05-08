/**
 * run-media-stage.ts
 *
 * MediaStageRunner adoption helper. Slice 5a shipped UI + helper with
 * `providers: []` (every shot routed through gemini_flow paste-in).
 * Slice 5b adds optional HyperFrames provider injection: if the
 * `hyperframes` binary is on PATH, the helper bootstraps a per-venture
 * project under `<root>/10_media/hyperframes/`, installs the §12 core
 * preset blocks/components, constructs a HyperFrames provider, and
 * passes it to MediaStageRunner.providers. HyperFrames-eligible shots
 * (the resolver picks tier_0 for charts/UI/title cards) auto-render;
 * shots that need an AI engine still fall through to gemini_flow
 * paste-in until a Wan2/CogVideoX/Veo provider lands in slice 6+.
 *
 * LLM behaviour
 * -------------
 * Subscription-mode CLIs preferred per project policy. The script step
 * is LLM-aware via optional callLlm; without one it runs deterministic.
 *
 * Bootstrap behaviour
 * -------------------
 *  - First run on a venture: ~30s setup (init + 10 catalog adds).
 *  - Subsequent runs: skipped (project + assets persist on disk).
 *  - Bootstrap failure (network blip, npm permissions, etc.) falls
 *    back to gemini_flow paste-in -- the run still completes.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import {
  PRESET_CORE_BLOCKS,
  PRESET_CORE_COMPONENTS,
  type MediaProvider,
} from "@founder-os/media-core";
import {
  addCatalogItems,
  bootstrapHyperframesProject,
  createHyperframesProvider,
  HyperframesNotFoundError,
  runHyperframesJson,
} from "@founder-os/media-providers";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { MediaStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { getMediaDir } from "@founder-os/workspace-core";
import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunMediaStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  signal?: AbortSignal;
  force?: boolean;
};

export type HfStatus =
  | "ready" // probe ok, project bootstrapped, provider injected
  | "bootstrapped" // freshly bootstrapped this run (toast hint for the user)
  | "not-detected" // hyperframes binary not on PATH
  | "doctor-failed" // binary present but doctor returned ok:false (env issue)
  | "bootstrap-failed"; // binary + doctor ok, but init/add threw

export type RunMediaStageResult = {
  result: StageRunResult;
  steps: {
    script: "ok" | "missing";
    storyboard: "ok" | "missing";
    renderShots: "ok" | "missing" | "pending-flow";
    stitch: "ok" | "missing" | "skipped";
  };
  generationSource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
  pendingFlow: boolean;
  llmConfigured: boolean;
  hfStatus: HfStatus;
};

export async function runMediaStage(opts: RunMediaStageOpts): Promise<RunMediaStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });

  const { provider, hfStatus } = await ensureHyperframesProvider(opts.venture.rootPath);
  const providers: MediaProvider[] = provider ? [provider] : [];

  const runner = new MediaStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    providers,
    ...(llmCaller !== null ? { callLlm: llmCaller.callLlm } : {}),
  });
  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });
  const result = await orchestrator.runStage(runner, { force: opts.force ?? true });

  return {
    result,
    steps: deriveSteps(result.logs),
    generationSource: deriveGenerationSource(result.logs),
    pendingFlow: derivePendingFlow(result.logs),
    llmConfigured: llmCaller !== null,
    hfStatus,
  };
}

/**
 * Probe the hyperframes binary, ensure a per-venture project exists,
 * install the §12 core preset on first run, and return a MediaProvider
 * the runner can dispatch to. Returns { provider: null, hfStatus } when
 * any step fails so the caller falls back to the gemini_flow paste-in
 * path -- never throws.
 */
async function ensureHyperframesProvider(
  ventureRoot: string,
): Promise<{ provider: MediaProvider | null; hfStatus: HfStatus }> {
  // 1. Probe.
  let probe: { ok?: boolean };
  try {
    probe = await runHyperframesJson<{ ok?: boolean }>(["doctor"], { timeoutMs: 8_000 });
  } catch (err) {
    if (err instanceof HyperframesNotFoundError) {
      return { provider: null, hfStatus: "not-detected" };
    }
    return { provider: null, hfStatus: "doctor-failed" };
  }
  if (probe.ok !== true) {
    return { provider: null, hfStatus: "doctor-failed" };
  }

  // 2. Project root + bootstrap (idempotent: skips when index.html exists).
  const projectRoot = `${getMediaDir(ventureRoot)}/hyperframes`;
  let freshlyBootstrapped = false;
  try {
    const indexHtml = `${projectRoot}/index.html`;
    const exists = await tauriFs.exists(indexHtml);
    if (!exists) {
      await bootstrapHyperframesProject({
        root: projectRoot,
        example: "blank",
        tailwind: true,
        skipSkills: true,
        timeoutMs: 90_000,
      });
      // Install the §12 core preset (7 blocks + 3 components).
      await addCatalogItems(
        projectRoot,
        [...PRESET_CORE_BLOCKS, ...PRESET_CORE_COMPONENTS],
        { timeoutMs: 30_000 },
      );
      freshlyBootstrapped = true;
    }
  } catch {
    return { provider: null, hfStatus: "bootstrap-failed" };
  }

  const provider = createHyperframesProvider({ projectRoot });
  return {
    provider,
    hfStatus: freshlyBootstrapped ? "bootstrapped" : "ready",
  };
}

function deriveSteps(logs: LogEntry[]): RunMediaStageResult["steps"] {
  const steps: RunMediaStageResult["steps"] = {
    script: "missing",
    storyboard: "missing",
    renderShots: "missing",
    stitch: "missing",
  };
  for (const e of logs) {
    if (e.message === "media script written") {
      steps.script = "ok";
    } else if (e.message === "storyboard written") {
      steps.storyboard = "ok";
    } else if (e.message === "render-shots finished") {
      const data = e.data as Record<string, unknown> | undefined;
      const status = data?.status;
      if (status === "pending-flow") {
        steps.renderShots = "pending-flow";
      } else if (status === "done" || status === "partial") {
        steps.renderShots = "ok";
      }
    } else if (e.message === "launch reel stitched") {
      steps.stitch = "ok";
    } else if (e.message === "launch reel skipped") {
      steps.stitch = "skipped";
    }
  }
  return steps;
}

function deriveGenerationSource(
  logs: LogEntry[],
): "llm" | "deterministic" | "deterministic-fallback" | "unknown" {
  for (const e of logs) {
    if (e.message !== "media script written") continue;
    const gs = (e.data as Record<string, unknown> | undefined)?.generationSource;
    if (gs === "llm" || gs === "deterministic" || gs === "deterministic-fallback") {
      return gs;
    }
  }
  return "unknown";
}

function derivePendingFlow(logs: LogEntry[]): boolean {
  for (const e of logs) {
    if (e.message !== "render-shots finished") continue;
    const data = e.data as Record<string, unknown> | undefined;
    if (data?.status === "pending-flow") return true;
  }
  return false;
}
