#!/usr/bin/env tsx
/**
 * crm-providers Node sidecar CLI (slice 5b of CRM arc).
 *
 * The Tauri WebView can't import @founder-os/crm-providers/node directly
 * because the renderer is browser-class -- node:child_process and node:http
 * are externalised to stubs that throw on access (the blank-screen failure
 * mode documented in the media-providers PM-split memory).
 *
 * Solution mirrors the @founder-os/sales-agents CLI shape: the Tauri host
 * spawns a one-shot Node process via `pnpm --filter @founder-os/crm-providers
 * cli --`, the CLI does the Node-only work (Docker probe, bench probe, full
 * stage run with real providers), and emits a JSON envelope on stdout that
 * the Rust command parses and returns to the WebView.
 *
 * Subcommands:
 *   crm-providers probe-docker
 *   crm-providers probe-bench [--site-url http://localhost:8000]
 *   crm-providers run-stage   --venture-root <abs> --manifest <abs> [--force]
 *
 * Output contract: every successful run writes ONE line to stdout, a JSON
 * object matching the matching ProbeResult / RunStageResult schema below.
 * Diagnostic chatter goes to stderr.
 *
 * Errors: non-zero exit code + a JSON {"error": "..."} line on stdout so the
 * Rust side has a structured failure path even when something has gone sideways.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createConfigOnlyProvider,
  createFrappeBenchProvider,
  createFrappeDockerProvider,
  DockerNotFoundError,
  pickActiveCrmProvider,
  spawnDocker,
  type DockerBootstrapContext,
  type DockerBootstrapHandoff,
} from "./node.js";

// ---------------------------------------------------------------------------
// Envelope shapes -- match these exactly in the Rust crm.rs deserialisers.
// ---------------------------------------------------------------------------

type ProbeDockerResult =
  | { available: true; version: string }
  | { available: false; reason: string };

type ProbeBenchResult =
  | { available: true; siteUrl: string }
  | { available: false; reason: string };

/**
 * The run-stage envelope. `result` is a serialised StageRunResult from
 * @founder-os/stage-runners -- mirrored field-for-field so the WebView
 * can hand it straight to the same downstream consumers. `engineUsed`
 * is derived from the runner's "crm: provisioned" log entry so the IPC
 * boundary doesn't have to re-parse it on the Rust side. `checkpointPath`
 * is the venture-relative path to crm-checkpoint.json (if the runner
 * actually wrote it -- on validation failure it won't).
 */
type RunStageResult = {
  result: {
    success: boolean;
    stageName: string;
    runId: string;
    artifactsCreated: string[];
    logs: Array<{
      timestamp: string;
      level: string;
      message: string;
      data?: Record<string, unknown>;
    }>;
    requiresReview: boolean;
    reviewGateId?: string;
    nextStageReady: boolean;
    error?: { code: string; message: string; recoverable: boolean };
  };
  engineUsed: "frappe_docker" | "frappe_bench" | "config_only" | "unknown";
  checkpointPath?: string;
};

type ErrorEnvelope = { error: string };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Strip the conventional `--` separator if pnpm/tsx forwarded it as a
  // literal argv entry. pnpm 10 passes `--` through to the script when
  // invoked as `pnpm --filter X cli -- <args>`, so without this guard we'd
  // see argv[2] === "--" and print usage. Belt-and-braces: also filter
  // any later bare `--` token in case a caller doubles up.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "probe-docker") {
      emit(await probeDocker());
      return;
    }
    if (cmd === "probe-bench") {
      emit(await probeBench(rest));
      return;
    }
    if (cmd === "run-stage") {
      emit(await runStage(rest));
      return;
    }
    printUsage();
    process.exit(cmd ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit<ErrorEnvelope>({ error: message });
    process.exit(1);
  }
}

function emit<T>(payload: T): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printUsage(): void {
  process.stderr.write(
    [
      "crm-providers CLI",
      "",
      "Usage:",
      "  crm-providers probe-docker",
      "  crm-providers probe-bench [--site-url http://localhost:8000]",
      "  crm-providers run-stage   --venture-root <abs> --manifest <abs> [--force]",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// probe-docker
// ---------------------------------------------------------------------------

async function probeDocker(): Promise<ProbeDockerResult> {
  try {
    const res = await spawnDocker({
      args: ["version", "--format", "{{.Server.Version}}"],
      timeoutMs: 3000,
    });
    if (res.exitCode === 0) {
      return { available: true, version: res.stdout.trim() };
    }
    return {
      available: false,
      reason: `docker version exited ${res.exitCode}: ${res.stderr.trim()}`,
    };
  } catch (cause) {
    if (cause instanceof DockerNotFoundError) {
      return { available: false, reason: cause.message };
    }
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// probe-bench
// ---------------------------------------------------------------------------

async function probeBench(args: string[]): Promise<ProbeBenchResult> {
  const siteUrl = flag(args, "--site-url") ?? "http://localhost:8000";
  // We don't have credentials here, so we can't use the real provider's
  // available() (it requires loadCredentials). Probe the /api/method/ping
  // endpoint directly. 401 = container responding, just unauthenticated.
  try {
    const res = await fetch(`${siteUrl}/api/method/ping`, {
      method: "GET",
      // Short timeout via AbortSignal.timeout (Node 17.3+, Tauri ships 20).
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok || res.status === 401) {
      return { available: true, siteUrl };
    }
    return {
      available: false,
      reason: `ping returned HTTP ${res.status}`,
    };
  } catch (cause) {
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// run-stage
// ---------------------------------------------------------------------------

async function runStage(args: string[]): Promise<RunStageResult> {
  const ventureRoot = required(flag(args, "--venture-root"), "--venture-root");
  const manifestPath = required(flag(args, "--manifest"), "--manifest");
  const force = args.includes("--force");

  if (!existsSync(ventureRoot)) {
    throw new Error(`venture root does not exist: ${ventureRoot}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest does not exist: ${manifestPath}`);
  }

  // Dynamic imports keep stage-runners + pipeline-runner out of the cold
  // import graph for probe-only invocations. The CLI doesn't need them
  // until run-stage actually fires.
  const { CrmStageRunner, PipelineOrchestrator } = await import(
    "@founder-os/stage-runners"
  );
  const { nodeFs } = await import("@founder-os/pipeline-runner");
  const { VentureManifestSchema } = await import("@founder-os/domain");

  const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = VentureManifestSchema.parse(manifestRaw);
  const ventureSlug = manifest.slug;

  const fs = nodeFs;

  // Wire real providers. The bootstrap callback is a no-op stub here: the
  // Tauri command surface lets the user trigger Docker bootstrap explicitly
  // through a separate UI affordance (a follow-up); a run-stage invocation
  // assumes either (a) the stack is already up, or (b) the resolver falls
  // through to config_only.
  const docker = createFrappeDockerProvider({
    ventureSlug,
    loadCredentials: async () => readCredentialsIfPresent(ventureSlug),
    bootstrap: async (
      _input,
      ctx: DockerBootstrapContext,
    ): Promise<DockerBootstrapHandoff> => {
      // Refuse to silently bootstrap on the run-stage path -- the user
      // should kick that off explicitly via crm_bootstrap_docker (slice
      // 7b, out of scope here). Surfacing a structured error here lets
      // the resolver fall through to bench / config_only instead of
      // hanging on `docker compose up -d`.
      throw new Error(
        `bootstrap requested for ${ctx.composeProject} (state=${ctx.state}); ` +
          `run 'crm-providers bootstrap-docker' first or enable a different engine`,
      );
    },
  });
  const bench = createFrappeBenchProvider({
    loadCredentials: async () => readCredentialsIfPresent(ventureSlug),
  });
  const configOnly = createConfigOnlyProvider();

  // The resolver runs available() to pick. We don't pre-pick here; the
  // CrmStageRunner expects an explicit `providers` map by engine. Build
  // the map and let the runner's tier ladder choose.
  const providers = {
    frappe_docker: docker,
    frappe_bench: bench,
    config_only: configOnly,
  } as const;

  // pickActiveCrmProvider returns the chosen one; we don't actually need
  // it here since CrmStageRunner has its own tier ladder. We invoke it
  // only to log the choice for diagnostics.
  try {
    const choice = await pickActiveCrmProvider({
      tierList: ["frappe_docker", "frappe_bench", "config_only"],
      providers,
    });
    process.stderr.write(
      `[crm-providers] resolved provider: ${choice.provider?.name ?? "none"}\n`,
    );
    for (const a of choice.attempts) {
      process.stderr.write(
        `[crm-providers]   ${a.engine}: available=${a.available}${a.skipped ? " (skipped)" : ""}\n`,
      );
    }
  } catch (cause) {
    process.stderr.write(
      `[crm-providers] resolver warning: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }

  const runner = new CrmStageRunner({
    manifest,
    ventureRoot,
    fs,
    providers,
  });
  const orchestrator = new PipelineOrchestrator({
    manifest,
    ventureRoot,
    fs,
  });
  const result = await orchestrator.runStage(runner, { force });

  const engineUsed = deriveEngineUsed(result.logs);
  const checkpointPath = resolve(ventureRoot, "11_crm/crm-checkpoint.json");
  return {
    result: {
      success: result.success,
      stageName: result.stageName,
      runId: result.runId,
      artifactsCreated: result.artifactsCreated,
      logs: result.logs.map((l) => ({
        timestamp: l.timestamp,
        level: l.level,
        message: l.message,
        ...(l.data !== undefined ? { data: l.data as Record<string, unknown> } : {}),
      })),
      requiresReview: result.requiresReview,
      ...(result.reviewGateId !== undefined ? { reviewGateId: result.reviewGateId } : {}),
      nextStageReady: result.nextStageReady,
      ...(result.error !== undefined ? { error: result.error } : {}),
    },
    engineUsed,
    ...(existsSync(checkpointPath) ? { checkpointPath } : {}),
  };
}

function readCredentialsIfPresent(
  _ventureSlug: string,
): { apiKey: string; apiSecret: string } | null {
  // Placeholder: real secret storage is handled by the keyring Tauri
  // commands and the encrypted-at-rest file under ~/.founder-os/crm/.
  // The CLI doesn't have that surface yet, so we always return null
  // and let the resolver fall through. Slice 7b will wire a secrets
  // file reader here so a running compose project can be reused.
  return null;
}

function deriveEngineUsed(
  logs: ReadonlyArray<{ message: string; data?: unknown }>,
): RunStageResult["engineUsed"] {
  for (const e of logs) {
    if (e.message === "crm: provisioned") {
      const data = e.data as { engine?: unknown } | undefined;
      const engine = data?.engine;
      if (
        engine === "frappe_docker" ||
        engine === "frappe_bench" ||
        engine === "config_only"
      ) {
        return engine;
      }
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tiny argv helpers
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
});
