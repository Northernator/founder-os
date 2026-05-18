/**
 * run-crm-stage.ts
 *
 * CrmStageRunner adoption helper.
 *
 * Slice 5a shipped the helper with `providers: { config_only: ... }` -- every
 * run routed through the config_only provider, which writes JSON exports
 * under 11_crm/ but never calls HTTP and never spawns Docker.
 *
 * Slice 5b wires Tauri commands (crm_probe_docker, crm_probe_bench,
 * crm_run_stage). The WebView now:
 *   1. Calls crm_probe_docker / crm_probe_bench to populate the engine
 *      pills in CrmTab (this turns the previously-hardcoded "disabled"
 *      states into real states based on the user's machine).
 *   2. If a live engine is detected AND the venture's manifest opts into
 *      it, delegates the whole run to crm_run_stage so the Node sidecar
 *      can drive the real providers. The WebView still parses the result
 *      with the same drift-protected log strings so downstream UI doesn't
 *      branch.
 *   3. Otherwise falls back to the in-webview config_only path (this is
 *      the path that's been working since slice 5a -- the regression
 *      surface for slice 5b stays narrow).
 *
 * Why the indirection: @founder-os/crm-providers/node imports node:http
 * + node:child_process. Vite externalises both for the WebView, which
 * means importing them straight from React would unmount the tree on
 * first access -- the same blank-screen failure mode the media slice 5b
 * memory documents. The PM split keeps that boundary loud.
 *
 * LLM behaviour
 * -------------
 * Subscription-mode CLIs preferred per project policy. The campaign-
 * template step is LLM-aware via optional callLlm; without one it emits
 * deterministic templates. When the run delegates to the Node sidecar,
 * the sidecar's CLI uses its own LLM caller (currently deterministic --
 * subscription-aware caller is follow-up work).
 */
import type { CrmEngine, CrmProvider } from "@founder-os/crm-core";
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { CrmStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { invoke } from "@tauri-apps/api/core";

import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunCrmStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  signal?: AbortSignal;
  force?: boolean;
};

/**
 * 5-state engine pill, mirroring HfStatus shape:
 *  - ready          probe ok, provider wired, ran live
 *  - not-detected   probe negative (Docker daemon down / no bench port)
 *  - probe-failed   probe threw (Tauri sidecar crashed)
 *  - disabled       engine not in manifest.crm.engineTiers
 *  - config-only    no live engine resolved; ran config_only fallback
 */
export type CrmEngineStatus =
  | "ready"
  | "not-detected"
  | "probe-failed"
  | "disabled"
  | "config-only";

export type RunCrmStageResult = {
  result: StageRunResult;
  steps: {
    provision: "ok" | "missing";
    seed: "ok" | "missing";
    campaign: "ok" | "missing";
    checkpoint: "ok" | "missing";
  };
  engineUsed: CrmEngine | "unknown";
  dockerStatus: CrmEngineStatus;
  benchStatus: CrmEngineStatus;
  generationSource: "llm" | "deterministic" | "unknown";
  llmConfigured: boolean;
  /**
   * Counts surfaced from the seed step log. Defaults to zero when the
   * step didn't run.
   */
  counts: { segments: number; contacts: number; opportunities: number };
};

export async function runCrmStage(opts: RunCrmStageOpts): Promise<RunCrmStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });

  // Probe live engines via the Tauri sidecar (slice 5b).
  const dockerStatus = await probeCrmDockerViaTauri(opts.manifest);
  const benchStatus = await probeCrmBenchViaTauri(opts.manifest);

  // If a live engine is both available AND opted-in for this venture,
  // delegate the run to the Node sidecar via crm_run_stage. The sidecar
  // can talk to the real Frappe HTTP API (Docker / bench); the WebView
  // can't.
  const liveEngine = pickLiveEngine(opts.manifest, dockerStatus, benchStatus);
  if (liveEngine !== null) {
    try {
      const sidecar = await invokeCrmRunStageViaTauri({
        ventureRoot: opts.venture.rootPath,
        manifest: opts.manifest,
        force: opts.force ?? true,
      });
      return {
        result: sidecar.result,
        steps: deriveSteps(sidecar.result.logs),
        engineUsed: sidecar.engineUsed,
        dockerStatus,
        benchStatus,
        generationSource: deriveGenerationSource(sidecar.result.logs),
        llmConfigured: llmCaller !== null,
        counts: deriveCounts(sidecar.result.logs),
      };
    } catch (cause) {
      // Surface the sidecar failure as a stage log + fall through to the
      // webview config_only path. This keeps "Run CRM stage" working when
      // pnpm isn't on PATH or the workspace root can't be located.
      console.warn("[run-crm-stage] sidecar failed, falling back:", cause);
    }
  }

  const providers: Partial<Record<CrmEngine, CrmProvider>> = {
    config_only: makeWebviewConfigOnlyProvider(opts.venture, opts.manifest),
  };

  const runner = new CrmStageRunner({
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
    engineUsed: deriveEngineUsed(result.logs),
    dockerStatus,
    benchStatus,
    generationSource: deriveGenerationSource(result.logs),
    llmConfigured: llmCaller !== null,
    counts: deriveCounts(result.logs),
  };
}

/**
 * Decide whether to route through the Node sidecar based on probe state
 * and the venture's opt-in tier list. Returns null when no live engine
 * is available, which keeps the WebView on the config_only path.
 */
function pickLiveEngine(
  manifest: VentureManifest,
  dockerStatus: CrmEngineStatus,
  benchStatus: CrmEngineStatus,
): CrmEngine | null {
  const tiers = manifest.crm?.engineTiers ?? [
    "frappe_docker",
    "frappe_bench",
    "config_only",
  ];
  for (const engine of tiers) {
    if (engine === "frappe_docker" && dockerStatus === "ready") return "frappe_docker";
    if (engine === "frappe_bench" && benchStatus === "ready") return "frappe_bench";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webview-safe config_only provider
// ---------------------------------------------------------------------------

/**
 * A minimal config_only provider that runs inside the webview. Doesn't
 * import any node:* modules. Just no-ops the upsert* methods (the seed
 * step's JSON-on-disk write is the actual side-effect) and returns a
 * placeholder CrmInstance.
 *
 * Slice 5b replaces this with a Tauri-shaped provider that delegates to
 * @founder-os/crm-providers/node via IPC.
 */
function makeWebviewConfigOnlyProvider(
  venture: Venture,
  manifest: VentureManifest,
): CrmProvider {
  return {
    name: "config_only",
    async available() {
      return true;
    },
    async provision() {
      return {
        ventureSlug: venture.slug,
        engine: "config_only",
        adminEmail: manifest.crm?.adminEmail ?? "founder@example.com",
        provisionedAt: new Date().toISOString(),
        notes: "webview config_only -- slice 5b promotes this to IPC-backed providers.",
      };
    },
    async upsertSegments() {},
    async upsertContacts() {},
    async upsertOpportunities() {},
    async upsertTemplates() {},
    async createCampaign(c) {
      return { id: c.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Slice 5b -- Tauri probes
// ---------------------------------------------------------------------------

/**
 * Envelopes the Rust commands emit. Match these shapes against the JSON
 * the @founder-os/crm-providers CLI produces (cli.ts). Serde's untagged
 * encoding means we just need the discriminating fields to disambiguate.
 */
type CrmProbeDockerResultIpc =
  | { available: true; version: string }
  | { available: false; reason: string }
  | { error: string };

type CrmProbeBenchResultIpc =
  | { available: true; siteUrl: string }
  | { available: false; reason: string }
  | { error: string };

type CrmRunStageResultIpc =
  | {
      /** Serialised StageRunResult from the sidecar -- we trust the shape. */
      result: StageRunResult;
      engineUsed: CrmEngine | "unknown";
      checkpointPath?: string;
    }
  | { error: string };

/**
 * Probe Docker availability via the Node sidecar. Three-way mapping into
 * CrmEngineStatus:
 *   - manifest opted out                      => "disabled"
 *   - probe -> available=true                 => "ready"
 *   - probe -> available=false                => "not-detected"
 *   - sidecar errored / Tauri host unreachable=> "probe-failed"
 */
async function probeCrmDockerViaTauri(
  manifest: VentureManifest,
): Promise<CrmEngineStatus> {
  if (!manifestEnables(manifest, "frappe_docker")) return "disabled";
  try {
    const result = await invoke<CrmProbeDockerResultIpc>("crm_probe_docker");
    if ("error" in result) return "probe-failed";
    return result.available ? "ready" : "not-detected";
  } catch (cause) {
    console.warn("[run-crm-stage] crm_probe_docker failed:", cause);
    return "probe-failed";
  }
}

async function probeCrmBenchViaTauri(
  manifest: VentureManifest,
): Promise<CrmEngineStatus> {
  if (!manifestEnables(manifest, "frappe_bench")) return "disabled";
  try {
    const siteUrl = manifest.crm?.bench?.siteUrl;
    const result = await invoke<CrmProbeBenchResultIpc>("crm_probe_bench", {
      siteUrl: siteUrl ?? null,
    });
    if ("error" in result) return "probe-failed";
    return result.available ? "ready" : "not-detected";
  } catch (cause) {
    console.warn("[run-crm-stage] crm_probe_bench failed:", cause);
    return "probe-failed";
  }
}

function manifestEnables(manifest: VentureManifest, engine: CrmEngine): boolean {
  const tiers = manifest.crm?.engineTiers;
  // No explicit tier list -> defaults apply -> every engine is potentially enabled.
  if (!tiers || tiers.length === 0) return true;
  return tiers.includes(engine);
}

/**
 * Invoke the Node sidecar to run the CRM stage end-to-end with real
 * providers. Writes the manifest to a sibling .json file the sidecar can
 * read directly -- the CLI parses it via VentureManifestSchema so a stale
 * shape will surface as a clear parse error instead of a runtime crash.
 */
async function invokeCrmRunStageViaTauri(args: {
  ventureRoot: string;
  manifest: VentureManifest;
  force: boolean;
}): Promise<{
  result: StageRunResult;
  engineUsed: CrmEngine | "unknown";
  checkpointPath?: string;
}> {
  // Materialise the manifest as JSON so the sidecar has something to
  // parse. We write under .founder/ -- that directory is already managed
  // by the workspace and gets git-ignored.
  const manifestPath = `${args.ventureRoot}/.founder/manifest-snapshot.json`;
  await tauriFs.writeFile(manifestPath, JSON.stringify(args.manifest, null, 2));

  const ipc = await invoke<CrmRunStageResultIpc>("crm_run_stage", {
    ventureRoot: args.ventureRoot,
    manifestPath,
    force: args.force,
  });
  if ("error" in ipc) {
    throw new Error(`crm_run_stage sidecar error: ${ipc.error}`);
  }
  return {
    result: ipc.result,
    engineUsed: ipc.engineUsed,
    ...(ipc.checkpointPath !== undefined ? { checkpointPath: ipc.checkpointPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Log derivation -- parses the 5 drift-protected strings.
// ---------------------------------------------------------------------------

function deriveSteps(logs: LogEntry[]): RunCrmStageResult["steps"] {
  const steps: RunCrmStageResult["steps"] = {
    provision: "missing",
    seed: "missing",
    campaign: "missing",
    checkpoint: "missing",
  };
  for (const e of logs) {
    if (e.message === "crm: provisioned") steps.provision = "ok";
    else if (e.message === "crm: seeded") steps.seed = "ok";
    else if (e.message === "crm: campaign created") steps.campaign = "ok";
    else if (e.message === "crm: checkpoint written") steps.checkpoint = "ok";
  }
  return steps;
}

function deriveEngineUsed(logs: LogEntry[]): CrmEngine | "unknown" {
  for (const e of logs) {
    if (e.message === "crm: provisioned") {
      const data = e.data as Record<string, unknown> | undefined;
      const engine = data?.engine;
      if (engine === "frappe_docker" || engine === "frappe_bench" || engine === "config_only") {
        return engine;
      }
    }
  }
  return "unknown";
}

function deriveGenerationSource(logs: LogEntry[]): RunCrmStageResult["generationSource"] {
  for (const e of logs) {
    if (e.message === "crm: campaign created") {
      const data = e.data as Record<string, unknown> | undefined;
      const src = data?.generationSource;
      if (src === "llm" || src === "deterministic") return src;
    }
  }
  return "unknown";
}

function deriveCounts(logs: LogEntry[]): RunCrmStageResult["counts"] {
  const counts = { segments: 0, contacts: 0, opportunities: 0 };
  for (const e of logs) {
    if (e.message === "crm: seeded") {
      const data = e.data as Record<string, unknown> | undefined;
      if (typeof data?.segments === "number") counts.segments = data.segments;
      if (typeof data?.contacts === "number") counts.contacts = data.contacts;
      if (typeof data?.opportunities === "number") counts.opportunities = data.opportunities;
    }
  }
  return counts;
}
