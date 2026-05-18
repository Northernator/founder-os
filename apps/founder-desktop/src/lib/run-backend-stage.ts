/**
 * run-backend-stage.ts -- slice 5a of backend arc.
 *
 * BackendStageRunner adoption helper. Mirrors run-crm-stage.ts exactly.
 *
 * Slice 5a wiring
 * ---------------
 * Every run routes through a webview-safe `config_only` provider that
 * writes JSON artifacts but never spawns the PocketBase binary or talks
 * to it over HTTP. The runner sees a non-empty providers map -> takes
 * the real path -> emits the 6 drift-protected log strings the
 * deriveSteps() helper below parses.
 *
 * Slice 5b will wire Tauri commands (backend_probe_pocketbase,
 * backend_download_binary, backend_serve_dev, backend_stop_dev) and
 * delegate the run to a Node sidecar that drives real PocketBase. The
 * helper's surface is shaped to absorb that change without touching
 * BackendTab.
 *
 * Why the indirection: @founder-os/backend-providers/node imports
 * node:child_process / node:fs / node:http. Vite externalises all three
 * for the WebView, which means importing them straight from React would
 * unmount the tree on first access -- the same blank-screen failure mode
 * documented in media slice 5b memory. The PM split keeps that boundary
 * loud.
 *
 * LLM behaviour
 * -------------
 * Subscription-mode CLIs preferred per project policy. The hooks step
 * is LLM-aware via optional callLlm; without one it emits deterministic
 * stubs from raw AC text. When the run delegates to the Node sidecar
 * (slice 5b), the sidecar's CLI uses its own LLM caller.
 */
import type {
  BackendEngine,
  BackendExport,
  BackendInstance,
  BackendProvider,
  Collection,
} from "@founder-os/backend-core";
import type { Venture, VentureManifest } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { BackendStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { invoke } from "@tauri-apps/api/core";

import { tauriFs } from "./pipeline-fs.js";
import { buildPipelineLlmCaller } from "./pipeline-llm.js";

export type RunBackendStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  signal?: AbortSignal;
  force?: boolean;
};

/**
 * 5-state engine pill (mirrors CrmEngineStatus + MediaEngineStatus):
 *  - ready          probe ok, provider wired, ran live
 *  - not-detected   probe negative (binary not present, port not bound)
 *  - probe-failed   probe threw (Tauri sidecar crashed)
 *  - disabled       engine not in manifest.backend.enabledEngines
 *  - config-only    no live engine resolved; ran config_only fallback
 */
export type BackendEngineStatus =
  | "ready"
  | "not-detected"
  | "probe-failed"
  | "disabled"
  | "config-only";

export type RunBackendStageResult = {
  result: StageRunResult;
  steps: {
    provision: "ok" | "missing";
    schema: "ok" | "missing";
    hooks: "ok" | "missing";
    export: "ok" | "missing";
    checkpoint: "ok" | "missing";
  };
  engineUsed: BackendEngine | "unknown";
  pocketbaseStatus: BackendEngineStatus;
  generationSource: "llm-refined" | "deterministic" | "unknown";
  llmConfigured: boolean;
  counts: {
    collectionsApplied: number;
    hooksGenerated: number;
    collectionCount: number;
  };
};

type BackendManifestSubset = {
  enabledEngines?: BackendEngine[];
};

function readBackendManifest(manifest: VentureManifest): BackendManifestSubset {
  // manifest.backend lives outside the typed VentureManifestSchema today
  // -- the schema-level addition lands in a separate slice. Access it
  // loosely until then.
  return (
    (manifest as { backend?: BackendManifestSubset }).backend ?? {}
  );
}

export async function runBackendStage(
  opts: RunBackendStageOpts,
): Promise<RunBackendStageResult> {
  const llmCaller = await buildPipelineLlmCaller({
    ventureId: opts.venture.id,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    enableWebSearch: false,
  });

  // Probe live engines via the Tauri sidecar (slice 5b).
  const pocketbaseStatus = await probePocketbaseViaTauri(opts.manifest, opts.venture.rootPath);

  // If PocketBase is live AND opted-in for this venture, delegate the
  // run to the Node sidecar via backend_run_stage. The sidecar can talk
  // to the real PocketBase binary; the WebView can't.
  const liveEngine = pickLiveEngine(opts.manifest, pocketbaseStatus);
  if (liveEngine !== null) {
    try {
      const sidecar = await invokeBackendRunStageViaTauri({
        ventureRoot: opts.venture.rootPath,
        manifest: opts.manifest,
        force: opts.force ?? true,
      });
      return {
        result: sidecar.result,
        steps: deriveSteps(sidecar.result.logs),
        engineUsed: sidecar.engineUsed,
        pocketbaseStatus,
        generationSource: deriveGenerationSource(sidecar.result.logs),
        llmConfigured: llmCaller !== null,
        counts: deriveCounts(sidecar.result.logs),
      };
    } catch (cause) {
      // Surface the sidecar failure as a stage log + fall through to the
      // webview config_only path. This keeps "Run backend stage" working
      // when the sidecar isn't reachable.
      console.warn("[run-backend-stage] sidecar failed, falling back:", cause);
    }
  }

  const providers: Partial<Record<BackendEngine, BackendProvider>> = {
    config_only: makeWebviewConfigOnlyProvider(opts.venture),
  };

  const runner = new BackendStageRunner({
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
    pocketbaseStatus,
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
  pocketbaseStatus: BackendEngineStatus,
): BackendEngine | null {
  const backendCfg = readBackendManifest(manifest);
  const tiers = backendCfg.enabledEngines ?? [
    "pocketbase",
    "drizzle_sqlite",
    "config_only",
  ];
  for (const engine of tiers) {
    if (engine === "pocketbase" && pocketbaseStatus === "ready") return "pocketbase";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webview-safe config_only provider
// ---------------------------------------------------------------------------

/**
 * A minimal config_only provider that runs inside the webview. Doesn't
 * import any node:* modules. Schema-application is a no-op (the schema
 * step's JSON-on-disk write is the actual side-effect); export() emits a
 * stable placeholder shape so the SDK files always materialise.
 *
 * Slice 5b replaces this with a Tauri-shaped provider that delegates to
 * @founder-os/backend-providers/node via IPC.
 */
function makeWebviewConfigOnlyProvider(venture: Venture): BackendProvider {
  return {
    name: "config_only",
    async available() {
      return true;
    },
    async provision(): Promise<BackendInstance> {
      return {
        ventureSlug: venture.slug,
        engine: "config_only",
        adminEmail: "founder@example.com",
        provisionedAt: new Date().toISOString(),
        notes: "webview config_only -- slice 5b promotes this to IPC-backed providers.",
      };
    },
    async applySchema(): Promise<void> {
      // No-op. The schema step has already written
      // 12_backend/derived-collections.json before calling us.
    },
    async export(
      instance: BackendInstance,
      collections: Collection[],
    ): Promise<BackendExport> {
      return {
        ventureSlug: instance.ventureSlug,
        engine: "config_only",
        source: "config_only",
        // config_only has no live URL; emit a sentinel so BUILD's
        // scaffold knows to stub network calls.
        baseUrl: "http://localhost:0",
        collections,
        auth: { providers: ["password"], userFields: [] },
        sdk: {
          language: "ts",
          importPath: "@/lib/backend",
          realtime: false,
          reactHooks: false,
        },
        generatedAt: new Date().toISOString(),
        notes: [
          "webview config_only provider -- no live backend.",
          "BUILD scaffolds stub network calls; switch tier when ready.",
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Slice 5b -- Tauri probes (stubs until commands ship)
// ---------------------------------------------------------------------------

/**
 * Envelopes the Rust commands emit. Match these shapes against the JSON
 * the @founder-os/backend-providers CLI produces (cli.ts in slice 5b).
 * Serde's untagged encoding means we just need the discriminating fields
 * to disambiguate.
 */
type BackendProbePocketbaseResultIpc =
  | { available: true; binaryPath: string; resolvedVersion: string }
  | { available: false; reason: string }
  | { error: string };

type BackendRunStageResultIpc =
  | {
      /** Serialised StageRunResult from the sidecar -- we trust the shape. */
      result: StageRunResult;
      engineUsed: BackendEngine | "unknown";
      checkpointPath?: string;
    }
  | { error: string };

/**
 * Probe PocketBase availability via the Node sidecar (slice 5b).
 *
 * The Rust command (backend::backend_probe_pocketbase) spawns the
 * @founder-os/backend-providers CLI which checks the per-venture binary
 * at <ventureRoot>/12_backend/pocketbase/pocketbase(.exe). Passing the
 * venture root via IPC keeps the probe per-venture without baking the
 * path into Rust.
 *
 * Four-way mapping into BackendEngineStatus:
 *   - manifest opted out                      => "disabled"
 *   - probe -> available=true                 => "ready"
 *   - probe -> available=false                => "not-detected"
 *   - sidecar errored / Tauri host unreachable=> "probe-failed"
 *
 * Slice 5b promoted the catch arm to "probe-failed" -- the command now
 * exists, so a throw means a real bug (sidecar crash, missing pnpm on
 * PATH, etc.) rather than a missing-command stub.
 */
async function probePocketbaseViaTauri(
  manifest: VentureManifest,
  ventureRoot: string,
): Promise<BackendEngineStatus> {
  if (!manifestEnables(manifest, "pocketbase")) return "disabled";
  try {
    const result = await invoke<BackendProbePocketbaseResultIpc>(
      "backend_probe_pocketbase",
      { ventureRoot },
    );
    if ("error" in result) return "probe-failed";
    return result.available ? "ready" : "not-detected";
  } catch (cause) {
    console.warn(
      "[run-backend-stage] backend_probe_pocketbase invoke failed:",
      cause,
    );
    return "probe-failed";
  }
}

function manifestEnables(
  manifest: VentureManifest,
  engine: BackendEngine,
): boolean {
  const backendCfg = readBackendManifest(manifest);
  const tiers = backendCfg.enabledEngines;
  // No explicit tier list -> defaults apply -> every engine is potentially enabled.
  if (!tiers || tiers.length === 0) return true;
  return tiers.includes(engine);
}

/**
 * Invoke the Node sidecar to run the BACKEND stage end-to-end with real
 * providers (slice 5b). Writes the manifest to a sibling .json file the
 * sidecar can read directly -- the CLI parses it via
 * VentureManifestSchema so a stale shape will surface as a clear parse
 * error instead of a runtime crash.
 */
async function invokeBackendRunStageViaTauri(args: {
  ventureRoot: string;
  manifest: VentureManifest;
  force: boolean;
}): Promise<{
  result: StageRunResult;
  engineUsed: BackendEngine | "unknown";
  checkpointPath?: string;
}> {
  // Materialise the manifest as JSON so the sidecar has something to
  // parse. We write under .founder/ -- that directory is already managed
  // by the workspace and gets git-ignored.
  const manifestPath = `${args.ventureRoot}/.founder/manifest-snapshot.json`;
  await tauriFs.writeFile(manifestPath, JSON.stringify(args.manifest, null, 2));

  const ipc = await invoke<BackendRunStageResultIpc>("backend_run_stage", {
    ventureRoot: args.ventureRoot,
    manifestPath,
    force: args.force,
  });
  if ("error" in ipc) {
    throw new Error(`backend_run_stage sidecar error: ${ipc.error}`);
  }
  return {
    result: ipc.result,
    engineUsed: ipc.engineUsed,
    ...(ipc.checkpointPath !== undefined ? { checkpointPath: ipc.checkpointPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Log derivation -- parses the 6 drift-protected strings.
// ---------------------------------------------------------------------------

function deriveSteps(logs: LogEntry[]): RunBackendStageResult["steps"] {
  const steps: RunBackendStageResult["steps"] = {
    provision: "missing",
    schema: "missing",
    hooks: "missing",
    export: "missing",
    checkpoint: "missing",
  };
  for (const e of logs) {
    if (e.message === "backend: provisioned") steps.provision = "ok";
    else if (e.message === "backend: schema applied") steps.schema = "ok";
    else if (e.message === "backend: hooks generated") steps.hooks = "ok";
    else if (e.message === "backend: export written") steps.export = "ok";
    else if (e.message === "backend: checkpoint written") steps.checkpoint = "ok";
  }
  return steps;
}

function deriveEngineUsed(logs: LogEntry[]): BackendEngine | "unknown" {
  for (const e of logs) {
    if (e.message === "backend: provisioned") {
      const data = e.data as Record<string, unknown> | undefined;
      const engine = data?.engine;
      if (
        engine === "pocketbase" ||
        engine === "supabase" ||
        engine === "convex" ||
        engine === "appwrite" ||
        engine === "drizzle_sqlite" ||
        engine === "config_only"
      ) {
        return engine;
      }
    }
  }
  return "unknown";
}

function deriveGenerationSource(
  logs: LogEntry[],
): RunBackendStageResult["generationSource"] {
  for (const e of logs) {
    if (e.message === "backend: hooks generated") {
      const data = e.data as Record<string, unknown> | undefined;
      const src = data?.generationSource;
      if (src === "llm-refined" || src === "deterministic") return src;
    }
  }
  return "unknown";
}

function deriveCounts(logs: LogEntry[]): RunBackendStageResult["counts"] {
  const counts = { collectionsApplied: 0, hooksGenerated: 0, collectionCount: 0 };
  for (const e of logs) {
    const data = e.data as Record<string, unknown> | undefined;
    if (e.message === "backend: schema applied") {
      if (typeof data?.collectionsApplied === "number") {
        counts.collectionsApplied = data.collectionsApplied;
      }
    } else if (e.message === "backend: hooks generated") {
      if (typeof data?.hooksGenerated === "number") {
        counts.hooksGenerated = data.hooksGenerated;
      }
    } else if (e.message === "backend: export written") {
      if (typeof data?.collectionCount === "number") {
        counts.collectionCount = data.collectionCount;
      }
    }
  }
  return counts;
}
