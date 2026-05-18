/**
 * run-media-stage.ts
 *
 * MediaStageRunner adoption helper.
 *
 * History
 * -------
 * Slice 5a (2026-05-08) shipped UI + helper with `providers: []` -- every
 * shot routed through gemini_flow paste-in.
 *
 * Slice 5b (2026-05-08) attempted to inject a HyperFrames provider by
 * importing `createHyperframesProvider` + `bootstrapHyperframesProject`
 * straight from `@founder-os/media-providers`. That barrel transitively
 * imported `node:child_process` via spawn.ts -- Vite externalised the
 * Node module and module evaluation threw on first access ("Module
 * node:child_process has been externalized for browser compatibility"),
 * unmounting the React tree and producing a blank screen. Architecturally
 * unsound regardless: the WebView cannot spawn child processes.
 *
 * Current state (slice 3b shipped 2026-05-17)
 * -------------------------------------------
 * Four Tauri commands now bridge the WebView to
 * @founder-os/media-providers/node via a one-shot pnpm-filtered CLI:
 *   hf_probe       -- is the hyperframes binary on PATH?
 *   hf_doctor      -- env health (FFmpeg, etc)
 *   hf_bootstrap   -- mkdir 10_media/hyperframes/, init, install §12 preset
 *   hf_render      -- render a single Shot through HyperFrames
 * probeHyperframesViaTauri walks probe -> doctor -> bootstrap and returns
 * an IPC-shaped MediaProvider whose render() invokes hf_render. The
 * WebView remains free of node:* imports (the renderer is browser-class
 * and would crash on access, per the PM-split memory).
 *
 * LLM behaviour
 * -------------
 * Subscription-mode CLIs preferred per project policy. The script step
 * is LLM-aware via optional callLlm; without one it runs deterministic.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Venture, VentureManifest } from "@founder-os/domain";
import type {
  MediaProvider,
  MediaRenderResult,
  Shot,
} from "@founder-os/media-core";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { MediaStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
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
  | "bootstrap-failed" // binary + doctor ok, but init/add threw
  | "disabled"; // hyperframes not in manifest.media.enabledEngines

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

  // Slice 8: per-venture engine toggles. Defaults to ['hyperframes',
  // 'gemini_flow'] when manifest.media is absent. Slice 3b (this file)
  // now actually constructs an IPC-shaped MediaProvider when the engine
  // is enabled AND probe + doctor + bootstrap all succeed via Tauri.
  const enabledEngines = opts.manifest.media?.enabledEngines ?? ["hyperframes", "gemini_flow"];
  const hyperframesEnabled = enabledEngines.includes("hyperframes");
  const { provider, hfStatus } = hyperframesEnabled
    ? await probeHyperframesViaTauri(opts.venture.rootPath)
    : { provider: null, hfStatus: "disabled" as const };
  const providers: MediaProvider[] = provider ? [provider] : [];

  const runner = new MediaStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    providers,
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
    result,
    steps: deriveSteps(result.logs),
    generationSource: deriveGenerationSource(result.logs),
    pendingFlow: derivePendingFlow(result.logs),
    llmConfigured: llmCaller !== null,
    hfStatus,
  };
}

// ---------------------------------------------------------------------------
// IPC envelope shapes -- mirror packages/media-providers/src/cli.ts and
// apps/founder-desktop/src-tauri/src/media.rs untagged enums. Each command
// returns one of (success | failure | { error }), so we model the IPC
// result as a discriminated union and let the caller branch.
// ---------------------------------------------------------------------------

type HfProbeResultIpc =
  | { available: true; version: string }
  | { available: false; reason: string }
  | { error: string };

type HfDoctorResultIpc =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; reason: string; raw?: Record<string, unknown> }
  | { error: string };

type HfBootstrapResultIpc =
  | {
      ok: true;
      projectPath: string;
      freshlyBootstrapped: boolean;
      installedBlocks: number;
      installedComponents: number;
    }
  | { ok: false; reason: string }
  | { error: string };

type HfRenderResultIpc =
  | {
      ok: true;
      path: string;
      durationSec: number;
      engine: string;
      meta?: Record<string, unknown>;
    }
  | { ok: false; reason: string; kind: "lint" | "layout" | "exit" | "spawn" | "other" }
  | { error: string };

/**
 * Slice 3b implementation: probe -> doctor -> bootstrap -> construct an
 * IPC-shaped MediaProvider whose render() invokes `hf_render` on the
 * Rust side. The provider keeps the WebView free of node:* imports
 * (every Node-only call funnels through Tauri commands defined in
 * apps/founder-desktop/src-tauri/src/media.rs).
 *
 * Status mapping:
 *   - probe.available === false                     -> "not-detected"
 *   - probe ok, doctor.ok === false                 -> "doctor-failed"
 *   - probe ok, doctor ok, bootstrap.ok === false   -> "bootstrap-failed"
 *   - all three ok, bootstrap.freshlyBootstrapped   -> "bootstrapped"
 *   - all three ok, bootstrap already initialised   -> "ready"
 *   - any IPC throw / envelope error                -> "not-detected"
 *     (degrades silently to gemini_flow paste-in; the warn() trail in
 *      DevTools is the diagnostic surface)
 *
 * The function intentionally never throws -- callers always fall back
 * to `providers: []` on a returned `provider:null`.
 */
async function probeHyperframesViaTauri(ventureRoot: string): Promise<{
  provider: MediaProvider | null;
  hfStatus: HfStatus;
}> {
  // 1. Probe -- is the hyperframes binary on PATH at all?
  let probe: HfProbeResultIpc;
  try {
    probe = await invoke<HfProbeResultIpc>("hf_probe");
  } catch (cause) {
    console.warn("[run-media-stage] hf_probe invoke failed:", cause);
    return { provider: null, hfStatus: "not-detected" };
  }
  if ("error" in probe) {
    console.warn("[run-media-stage] hf_probe sidecar error:", probe.error);
    return { provider: null, hfStatus: "not-detected" };
  }
  if (!probe.available) {
    console.info("[run-media-stage] hyperframes not detected:", probe.reason);
    return { provider: null, hfStatus: "not-detected" };
  }

  // 2. Doctor -- binary present; is the local env healthy (FFmpeg etc)?
  let doctor: HfDoctorResultIpc;
  try {
    doctor = await invoke<HfDoctorResultIpc>("hf_doctor", { ventureRoot });
  } catch (cause) {
    console.warn("[run-media-stage] hf_doctor invoke failed:", cause);
    return { provider: null, hfStatus: "doctor-failed" };
  }
  if ("error" in doctor) {
    console.warn("[run-media-stage] hf_doctor sidecar error:", doctor.error);
    return { provider: null, hfStatus: "doctor-failed" };
  }
  if (!doctor.ok) {
    console.warn("[run-media-stage] hyperframes doctor failed:", doctor.reason);
    return { provider: null, hfStatus: "doctor-failed" };
  }

  // 3. Bootstrap -- mkdir, hyperframes init (idempotent), install preset.
  let bootstrap: HfBootstrapResultIpc;
  try {
    bootstrap = await invoke<HfBootstrapResultIpc>("hf_bootstrap", { ventureRoot });
  } catch (cause) {
    console.warn("[run-media-stage] hf_bootstrap invoke failed:", cause);
    return { provider: null, hfStatus: "bootstrap-failed" };
  }
  if ("error" in bootstrap) {
    console.warn("[run-media-stage] hf_bootstrap sidecar error:", bootstrap.error);
    return { provider: null, hfStatus: "bootstrap-failed" };
  }
  if (!bootstrap.ok) {
    console.warn(
      "[run-media-stage] hyperframes bootstrap failed:",
      bootstrap.reason,
    );
    return { provider: null, hfStatus: "bootstrap-failed" };
  }

  // 4. Build the IPC provider. available() returns true unconditionally
  // because we just proved it via probe+doctor; the render-shots step
  // calls available() before dispatch but we've already done the probing.
  const provider: MediaProvider = {
    name: "hyperframes",
    async available(): Promise<boolean> {
      return true;
    },
    async render(shot: Shot, outDir: string): Promise<MediaRenderResult> {
      let ipc: HfRenderResultIpc;
      try {
        ipc = await invoke<HfRenderResultIpc>("hf_render", {
          ventureRoot,
          shotJson: JSON.stringify(shot),
          outDir,
        });
      } catch (cause) {
        throw new Error(
          `hf_render IPC failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if ("error" in ipc) {
        throw new Error(`hf_render sidecar error: ${ipc.error}`);
      }
      if (!ipc.ok) {
        throw new Error(`hf_render ${ipc.kind}: ${ipc.reason}`);
      }
      return {
        path: ipc.path,
        durationSec: ipc.durationSec,
        engine: ipc.engine as MediaRenderResult["engine"],
        ...(ipc.meta !== undefined ? { meta: ipc.meta } : {}),
      };
    },
  };

  return {
    provider,
    hfStatus: bootstrap.freshlyBootstrapped ? "bootstrapped" : "ready",
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
