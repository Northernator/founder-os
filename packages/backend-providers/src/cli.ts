#!/usr/bin/env tsx
/**
 * backend-providers Node sidecar CLI (slice 5b of backend arc).
 *
 * The Tauri WebView can't import @founder-os/backend-providers/node directly
 * because the renderer is browser-class -- node:child_process / node:http /
 * node:fs are externalised to stubs that throw on access (the blank-screen
 * failure mode documented in the media-providers PM-split memory).
 *
 * Solution mirrors @founder-os/crm-providers slice 5b exactly: the Tauri host
 * spawns a one-shot Node process via `pnpm --filter @founder-os/backend-providers
 * cli --`, the CLI does the Node-only work (binary probe, download, full stage
 * run with real providers), and emits a JSON envelope on stdout that the Rust
 * command parses and returns to the WebView.
 *
 * Subcommands:
 *   backend-providers probe-pocketbase    [--venture-root <abs>]
 *   backend-providers download-binary     --venture-root <abs> [--version 0.22.20]
 *   backend-providers run-stage           --venture-root <abs> --manifest <abs> [--force]
 *
 * Output contract: every successful run writes ONE line to stdout, a JSON
 * object matching the matching ProbePocketbaseResult / DownloadBinaryResult /
 * RunStageResult schema below. Diagnostic chatter goes to stderr.
 *
 * Errors: non-zero exit code + a JSON {"error": "..."} line on stdout so the
 * Rust side has a structured failure path even when something has gone sideways.
 *
 * serve-dev / stop-dev are deliberately deferred to a follow-up slice -- they
 * are operational concerns (running the live binary between stage runs) that
 * the rest of slice 5b doesn't need.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createConfigOnlyProvider,
  createPocketbaseProvider,
  downloadBinary,
  PocketbaseBinaryDownloadError,
  PocketbaseBinaryMissingError,
  pickActiveBackendProvider,
  binaryExists,
  resolveBinaryPath,
  resolveDownloadUrl,
} from "./node.js";
import { createSupabaseProvider, SupabaseBadCredentialsError, SupabaseHealthError } from "./supabase-provider.js";
import {
  safeParseSupabaseConfig,
  SUPABASE_DEFAULT_ANON_KEY_ENV_VAR,
  SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR,
} from "@founder-os/backend-core";

// ---------------------------------------------------------------------------
// Envelope shapes -- match these exactly in the Rust backend.rs deserialisers.
// ---------------------------------------------------------------------------

type ProbePocketbaseResult =
  | {
      available: true;
      binaryPath: string;
      resolvedVersion: string;
    }
  | { available: false; reason: string };

type DownloadBinaryResult =
  | {
      downloaded: true;
      binaryPath: string;
      resolvedVersion: string;
    }
  | { downloaded: false; reason: string };

/**
 * The run-stage envelope. `result` is a serialised StageRunResult from
 * @founder-os/stage-runners -- mirrored field-for-field so the WebView
 * can hand it straight to the same downstream consumers. `engineUsed`
 * is derived from the runner's "backend: provisioned" log entry so the IPC
 * boundary doesn't have to re-parse it on the Rust side. `checkpointPath`
 * is the venture-relative path to backend-checkpoint.json (if the runner
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
  engineUsed:
    | "pocketbase"
    | "supabase"
    | "convex"
    | "appwrite"
    | "drizzle_sqlite"
    | "config_only"
    | "unknown";
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
    if (cmd === "probe-pocketbase") {
      emit(await probePocketbase(rest));
      return;
    }
    if (cmd === "download-binary") {
      emit(await downloadBinaryCmd(rest));
      return;
    }
    if (cmd === "run-stage") {
      emit(await runStage(rest));
      return;
    }
    if (cmd === "probe-supabase") {
      emit(await probeSupabase(rest));
      return;
    }
    if (cmd === "save-supabase-credentials") {
      emit(await saveSupabaseCredentials(rest));
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
      "backend-providers CLI",
      "",
      "Usage:",
      "  backend-providers probe-pocketbase [--venture-root <abs>]",
      "  backend-providers download-binary  --venture-root <abs> [--version 0.22.20]",
      "  backend-providers run-stage        --venture-root <abs> --manifest <abs> [--force]",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// probe-pocketbase
// ---------------------------------------------------------------------------

async function probePocketbase(args: string[]): Promise<ProbePocketbaseResult> {
  const ventureRoot = flag(args, "--venture-root");
  // Per-venture probe: check the per-venture binary at the canonical path.
  // No venture-root -> nothing to probe (the WebView always passes one in
  // slice 5b; null surfaces a clear reason rather than a misleading false).
  if (!ventureRoot) {
    return {
      available: false,
      reason:
        "no --venture-root given; per-venture PocketBase binaries live under " +
        "<ventureRoot>/12_backend/pocketbase/. Pass --venture-root to probe a venture.",
    };
  }
  const binaryPath = resolveBinaryPath(ventureRoot);
  if (!binaryExists(binaryPath)) {
    return {
      available: false,
      reason:
        `binary not present at ${binaryPath}. Run 'backend-providers download-binary ` +
        `--venture-root ${ventureRoot}' or manually fetch ${resolveDownloadUrl()} and ` +
        "unzip into the same directory.",
    };
  }
  // Verify the file is regular + non-empty. We do not exec the binary just
  // to read its version -- that runs untrusted user code as a side effect
  // of a probe call, which is exactly what we want to avoid in 5b.
  try {
    const stat = statSync(binaryPath);
    if (!stat.isFile() || stat.size === 0) {
      return {
        available: false,
        reason: `binary at ${binaryPath} is not a regular non-empty file (size=${stat.size}, isFile=${stat.isFile()})`,
      };
    }
  } catch (cause) {
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  // 5b returns the version slot empty -- resolveBinaryPath doesn't shell
  // out, and we don't trust `pocketbase --version` for the probe path. The
  // runner's provision() will surface the resolved version when it runs.
  return {
    available: true,
    binaryPath,
    resolvedVersion: "",
  };
}

// ---------------------------------------------------------------------------
// download-binary
// ---------------------------------------------------------------------------

async function downloadBinaryCmd(args: string[]): Promise<DownloadBinaryResult> {
  const ventureRoot = required(flag(args, "--venture-root"), "--venture-root");
  const version = flag(args, "--version");
  const binaryPath = resolveBinaryPath(ventureRoot);

  // Already present -> short-circuit. The download path is deliberately
  // idempotent so repeated UI invocations don't redo work.
  if (binaryExists(binaryPath)) {
    return {
      downloaded: false,
      reason: `binary already present at ${binaryPath}; skipping download`,
    };
  }

  try {
    await downloadBinary({
      binaryPath,
      ...(version !== undefined ? { version } : {}),
    });
    return {
      downloaded: true,
      binaryPath,
      resolvedVersion: version ?? "",
    };
  } catch (cause) {
    if (cause instanceof PocketbaseBinaryDownloadError) {
      // The slice-2 stub throws this to point the user at the manual URL.
      // Until slice 6 fills in the real downloader, surface the URL + the
      // underlying cause so the UI can render a clear instruction.
      const detail = cause.cause instanceof Error ? cause.cause.message : String(cause.cause ?? "");
      return {
        downloaded: false,
        reason: `${cause.message}${detail ? ` -- ${detail}` : ""}`,
      };
    }
    return {
      downloaded: false,
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
  const { BackendStageRunner, PipelineOrchestrator } = await import(
    "@founder-os/stage-runners"
  );
  const { nodeFs } = await import("@founder-os/pipeline-runner");
  const { VentureManifestSchema } = await import("@founder-os/domain");

  const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = VentureManifestSchema.parse(manifestRaw);

  const fs = nodeFs;

  // Wire real providers. PocketBase requires the binary to be present
  // (loadCredentials returns an admin password placeholder -- the secrets
  // store wiring lands in a follow-up alongside the deploy story). On a
  // fresh venture without the binary, available() returns true loosely
  // and provision() throws PocketbaseBinaryMissingError -- which the
  // resolver translates into "skipped" and falls through to config_only.
  const pocketbase = createPocketbaseProvider({
    adminPassword: readAdminPasswordIfPresent(ventureRoot) ?? "founder-os-admin-placeholder",
  });
  const configOnly = createConfigOnlyProvider();

  const providers = {
    pocketbase,
    config_only: configOnly,
  } as const;

  // pickActiveBackendProvider runs available() to pick. We don't pre-pick
  // here; the BackendStageRunner has its own tier ladder. We invoke the
  // resolver only to log the choice for diagnostics.
  try {
    const choice = await pickActiveBackendProvider({
      tierList: ["pocketbase", "config_only"],
      providers,
    });
    process.stderr.write(
      `[backend-providers] resolved provider: ${choice.provider?.name ?? "none"}\n`,
    );
    for (const a of choice.attempts) {
      process.stderr.write(
        `[backend-providers]   ${a.engine}: available=${a.available}\n`,
      );
    }
  } catch (cause) {
    process.stderr.write(
      `[backend-providers] resolver warning: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }

  const runner = new BackendStageRunner({
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
  const checkpointPath = resolve(ventureRoot, "12_backend/backend-checkpoint.json");
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

function readAdminPasswordIfPresent(_ventureRoot: string): string | null {
  // Placeholder: real secret storage is handled by the keyring Tauri
  // commands and the encrypted-at-rest file under ~/.founder-os/backend/.
  // The CLI doesn't have that surface yet, so we always return null
  // and the provider's export() step will surface an auth error if it
  // can't authenticate. Slice 6+ wires a secrets file reader here so a
  // running PocketBase admin login can be reused.
  return null;
}

function deriveEngineUsed(
  logs: ReadonlyArray<{ message: string; data?: unknown }>,
): RunStageResult["engineUsed"] {
  for (const e of logs) {
    if (e.message === "backend: provisioned") {
      const data = e.data as { engine?: unknown } | undefined;
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
// Supabase subcommands (slice 7 of Supabase arc)
// ---------------------------------------------------------------------------

type ProbeSupabaseResult =
  | {
      available: true;
      projectUrl: string;
      version: string;
    }
  | { available: false; reason: string };

type SaveSupabaseCredentialsResult =
  | {
      saved: true;
      credentialsPath: string;
    }
  | { saved: false; reason: string };

/**
 * Best-effort .credentials.json reader. The file is gitignored and
 * holds the anon + service-role keys plus the projectUrl. Returns the
 * parsed object or null. Never throws -- callers fall back to env.
 */
function readSupabaseCredentialsFile(
  ventureRoot: string,
): Record<string, string> | null {
  const path = resolve(ventureRoot, "12_backend", "supabase", ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

async function probeSupabase(args: string[]): Promise<ProbeSupabaseResult> {
  const ventureRoot = flag(args, "--venture-root");
  if (!ventureRoot) {
    return {
      available: false,
      reason: "no --venture-root given; pass --venture-root to probe a venture\'s Supabase config.",
    };
  }
  const projectUrl = flag(args, "--project-url");
  if (!projectUrl) {
    return {
      available: false,
      reason: "no --project-url given; pass the project URL from supabase.com.",
    };
  }
  const anonKeyEnvVar = flag(args, "--anon-env") ?? SUPABASE_DEFAULT_ANON_KEY_ENV_VAR;
  const serviceRoleKeyEnvVar =
    flag(args, "--service-env") ?? SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR;

  const parsed = safeParseSupabaseConfig({
    projectUrl,
    anonKeyEnvVar,
    serviceRoleKeyEnvVar,
  });
  if (!parsed.success) {
    return {
      available: false,
      reason:
        "SupabaseConfig validation failed: " +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  // Merge process env with the gitignored .credentials.json so the
  // founder can paste keys via the BackendTab modal AND/OR have them
  // exported in their shell. Process env wins on conflict.
  const fileCreds = readSupabaseCredentialsFile(ventureRoot) ?? {};
  const env: Record<string, string | undefined> = { ...fileCreds };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const provider = createSupabaseProvider({
    config: parsed.data,
    env,
  });

  if (!(await provider.available())) {
    return {
      available: false,
      reason:
        "credentials did not resolve: ensure " +
        anonKeyEnvVar +
        " and " +
        serviceRoleKeyEnvVar +
        " are set in process env OR in 12_backend/supabase/.credentials.json.",
    };
  }

  // Validate against the live project by running provision() in dry-run
  // style. The provider's provision() hits /auth/v1/health which is a
  // fast public endpoint -- safe to call on every probe.
  try {
    const instance = await provider.provision({
      ventureSlug: "probe",
      ventureRoot,
      adminEmail: "probe@founder-os.local",
    });
    return {
      available: true,
      projectUrl: instance.baseUrl ?? parsed.data.projectUrl,
      version: instance.resolvedVersion ?? "supabase-unknown",
    };
  } catch (err) {
    if (err instanceof SupabaseBadCredentialsError) {
      return { available: false, reason: `bad credentials: ${err.message}` };
    }
    if (err instanceof SupabaseHealthError) {
      return {
        available: false,
        reason: `health probe failed: ${err.message}`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, reason: msg };
  }
}

async function saveSupabaseCredentials(
  args: string[],
): Promise<SaveSupabaseCredentialsResult> {
  const ventureRoot = required(flag(args, "--venture-root"), "--venture-root");
  const projectUrl = required(flag(args, "--project-url"), "--project-url");
  const anonKey = required(flag(args, "--anon-key"), "--anon-key");
  const serviceRoleKey = required(flag(args, "--service-role-key"), "--service-role-key");
  const anonKeyEnvVar = flag(args, "--anon-env") ?? SUPABASE_DEFAULT_ANON_KEY_ENV_VAR;
  const serviceRoleKeyEnvVar =
    flag(args, "--service-env") ?? SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR;

  const credentialsPath = resolve(
    ventureRoot,
    "12_backend",
    "supabase",
    ".credentials.json",
  );
  try {
    mkdirSync(dirname(credentialsPath), { recursive: true });
    const payload = {
      // The env-var-NAMED keys so when read back they resolve via the
      // same path the provider would use.
      [anonKeyEnvVar]: anonKey,
      [serviceRoleKeyEnvVar]: serviceRoleKey,
      // Also persist the projectUrl for easier debugging -- the
      // BackendTab reads this back to render the current value.
      projectUrl,
    };
    writeFileSync(credentialsPath, `${JSON.stringify(payload, null, 2)}\n`);
    return { saved: true, credentialsPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { saved: false, reason: message };
  }
}

// Suppress unused-import warnings for symbols only referenced in jsdoc /
// error narrowing chains (PocketbaseBinaryMissingError is mentioned in the
// run-stage commentary above; keep the import for static analysis tools).
void PocketbaseBinaryMissingError;

// ---------------------------------------------------------------------------
// Boot
// ------------------------------------------------