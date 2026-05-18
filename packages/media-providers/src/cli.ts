#!/usr/bin/env tsx
/**
 * media-providers Node sidecar CLI (slice 3b of media arc).
 *
 * The Tauri WebView can't import @founder-os/media-providers/node directly
 * because the renderer is browser-class -- node:child_process + node:fs are
 * externalised to stubs that throw on access (the blank-screen failure mode
 * documented in the media-providers PM-split memory, slice 5b regression).
 *
 * Solution mirrors crm-providers + backend-providers exactly: the Tauri
 * host spawns a one-shot Node process via `pnpm --filter
 * @founder-os/media-providers cli -- <subcommand>`, the CLI does the
 * Node-only work (HF binary probe, doctor, project bootstrap, single-shot
 * render), and emits a JSON envelope on stdout that the Rust command
 * parses and returns to the WebView.
 *
 * Subcommands:
 *   media-providers probe-hf
 *   media-providers doctor-hf     --project-root <abs>
 *   media-providers bootstrap-hf  --project-root <abs>
 *   media-providers render-hf     --project-root <abs> --shot-file <abs> --out-dir <abs>
 *
 * Output contract: every successful run writes ONE line to stdout, a JSON
 * object matching the corresponding result schema below. Diagnostic chatter
 * goes to stderr. Errors: non-zero exit code + a JSON {"error":"..."} line
 * on stdout so the Rust side has a structured failure path even when
 * something has gone sideways.
 *
 * Why a CLI shape instead of a one-shot Rust spawn of `hyperframes` directly:
 *   - Bootstrap installs PRESET_CORE_BLOCKS / PRESET_CORE_COMPONENTS via
 *     repeated `hyperframes add` calls; orchestrating that from Rust would
 *     duplicate logic that lives once in ensure-project.ts.
 *   - Render runs the lint + inspect gates before render -- same reason.
 *   - Doctor / probe are trivial individually but cheaper to keep on one
 *     codepath alongside the heavier commands.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PRESET_CORE_BLOCKS,
  PRESET_CORE_COMPONENTS,
  ShotSchema,
} from "@founder-os/media-core";

import {
  HyperframesExitError,
  HyperframesLayoutError,
  HyperframesLintError,
  HyperframesNotFoundError,
  HyperframesTimeoutError,
  addCatalogItems,
  bootstrapHyperframesProject,
  createHyperframesProvider,
  projectPaths,
  runHyperframes,
  runHyperframesJson,
} from "./node.js";

// ---------------------------------------------------------------------------
// Envelope shapes -- match these exactly in the Rust media.rs deserialisers.
// ---------------------------------------------------------------------------

type ProbeHfResult =
  | { available: true; version: string }
  | { available: false; reason: string };

type DoctorHfResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; reason: string; raw?: Record<string, unknown> };

type BootstrapHfResult =
  | {
      ok: true;
      projectPath: string;
      freshlyBootstrapped: boolean;
      installedBlocks: number;
      installedComponents: number;
    }
  | { ok: false; reason: string };

type RenderHfResult =
  | {
      ok: true;
      path: string;
      durationSec: number;
      engine: string;
      meta?: Record<string, unknown>;
    }
  | { ok: false; reason: string; kind: "lint" | "layout" | "exit" | "spawn" | "other" };

type ErrorEnvelope = { error: string };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Strip the conventional `--` separator if pnpm/tsx forwarded it as a
  // literal argv entry. pnpm 10 passes `--` through to the script when
  // invoked as `pnpm --filter X cli -- <args>`, so without this guard we'd
  // see argv[2] === "--" and print usage. Mirrors crm-providers CLI exactly.
  const argv = process.argv.slice(2).filter((a: string) => a !== "--");
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "probe-hf") {
      emit(await probeHf());
      return;
    }
    if (cmd === "doctor-hf") {
      emit(await doctorHf(rest));
      return;
    }
    if (cmd === "bootstrap-hf") {
      emit(await bootstrapHf(rest));
      return;
    }
    if (cmd === "render-hf") {
      emit(await renderHf(rest));
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
      "media-providers CLI",
      "",
      "Usage:",
      "  media-providers probe-hf",
      "  media-providers doctor-hf     --project-root <abs>",
      "  media-providers bootstrap-hf  --project-root <abs>",
      "  media-providers render-hf     --project-root <abs> --shot-file <abs> --out-dir <abs>",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// probe-hf
// ---------------------------------------------------------------------------

async function probeHf(): Promise<ProbeHfResult> {
  try {
    // `hyperframes --version` is the cheapest reachable subcommand. Some
    // CLIs use `-V`; HyperFrames documents `--version` (and accepts -v).
    // Short timeout -- this should return in milliseconds when present.
    const res = await runHyperframes(["--version"], { timeoutMs: 5000 });
    if (res.code === 0) {
      // The CLI prints something like "0.6.16" -- normalise whitespace.
      const version = res.stdout.trim() || res.stderr.trim() || "unknown";
      return { available: true, version };
    }
    return {
      available: false,
      reason: `hyperframes --version exited ${res.code}: ${res.stderr.trim()}`,
    };
  } catch (cause) {
    if (cause instanceof HyperframesNotFoundError) {
      return { available: false, reason: cause.message };
    }
    if (cause instanceof HyperframesTimeoutError) {
      return { available: false, reason: cause.message };
    }
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// doctor-hf
// ---------------------------------------------------------------------------

async function doctorHf(args: string[]): Promise<DoctorHfResult> {
  const projectRoot = required(flag(args, "--project-root"), "--project-root");
  // The HyperFrames doctor command checks the local env: Node version,
  // FFmpeg presence, etc. It runs cwd-independently in practice but we
  // pass projectRoot so any project-specific drift surfaces too. If the
  // dir doesn't exist yet (pre-bootstrap), fall back to no cwd so the
  // global doctor still runs.
  const cwd = existsSync(projectRoot) ? projectRoot : undefined;
  try {
    const raw = await runHyperframesJson<Record<string, unknown>>(
      ["doctor"],
      { ...(cwd !== undefined ? { cwd } : {}), timeoutMs: 15_000 },
    );
    const ok = raw?.ok === true;
    if (ok) return { ok: true, raw };
    return {
      ok: false,
      reason: typeof raw?.reason === "string"
        ? raw.reason
        : "hyperframes doctor returned ok:false",
      raw,
    };
  } catch (cause) {
    if (cause instanceof HyperframesNotFoundError) {
      return { ok: false, reason: cause.message };
    }
    if (cause instanceof HyperframesExitError) {
      return {
        ok: false,
        reason: `hyperframes doctor exit ${cause.code}: ${cause.stderr.slice(0, 240).trim()}`,
      };
    }
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// bootstrap-hf
// ---------------------------------------------------------------------------

async function bootstrapHf(args: string[]): Promise<BootstrapHfResult> {
  const projectRoot = required(flag(args, "--project-root"), "--project-root");

  try {
    await mkdir(projectRoot, { recursive: true });

    const paths = projectPaths(projectRoot);
    const alreadyInitialised = existsSync(paths.indexHtml);

    if (!alreadyInitialised) {
      process.stderr.write(
        `[media-providers] bootstrap: hyperframes init ${projectRoot}\n`,
      );
      await bootstrapHyperframesProject({
        root: projectRoot,
        // The default ("blank") gives us a clean shell; the catalog adds
        // below install the Founder OS preset on top.
      });
    } else {
      process.stderr.write(
        `[media-providers] bootstrap: project exists -- skipping init\n`,
      );
    }

    // §12 preset: 7 blocks + 3 components. Idempotent on the HF side
    // (re-running `add` on an installed item is a no-op). We re-run on
    // every bootstrap to self-heal partial installs from earlier runs.
    process.stderr.write(
      `[media-providers] installing PRESET_CORE_BLOCKS (${PRESET_CORE_BLOCKS.length})\n`,
    );
    await addCatalogItems(projectRoot, PRESET_CORE_BLOCKS);
    process.stderr.write(
      `[media-providers] installing PRESET_CORE_COMPONENTS (${PRESET_CORE_COMPONENTS.length})\n`,
    );
    await addCatalogItems(projectRoot, PRESET_CORE_COMPONENTS);

    return {
      ok: true,
      projectPath: projectRoot,
      freshlyBootstrapped: !alreadyInitialised,
      installedBlocks: PRESET_CORE_BLOCKS.length,
      installedComponents: PRESET_CORE_COMPONENTS.length,
    };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// render-hf
// ---------------------------------------------------------------------------

async function renderHf(args: string[]): Promise<RenderHfResult> {
  const projectRoot = required(flag(args, "--project-root"), "--project-root");
  const shotFile = required(flag(args, "--shot-file"), "--shot-file");
  const outDir = required(flag(args, "--out-dir"), "--out-dir");

  if (!existsSync(shotFile) || !statSync(shotFile).isFile()) {
    return { ok: false, reason: `shot file not found: ${shotFile}`, kind: "other" };
  }
  if (!existsSync(projectRoot)) {
    return {
      ok: false,
      reason: `project root does not exist: ${projectRoot} -- run bootstrap-hf first`,
      kind: "other",
    };
  }
  await mkdir(outDir, { recursive: true });

  let shot: ReturnType<typeof ShotSchema.parse>;
  try {
    shot = ShotSchema.parse(JSON.parse(readFileSync(shotFile, "utf8")));
  } catch (cause) {
    return {
      ok: false,
      reason: `failed to parse shot file: ${cause instanceof Error ? cause.message : String(cause)}`,
      kind: "other",
    };
  }

  const provider = createHyperframesProvider({ projectRoot: resolve(projectRoot) });

  try {
    const result = await provider.render(shot, resolve(outDir));
    return {
      ok: true,
      path: result.path,
      durationSec: result.durationSec,
      engine: result.engine,
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
    };
  } catch (cause) {
    if (cause instanceof HyperframesLintError) {
      return { ok: false, reason: cause.message, kind: "lint" };
    }
    if (cause instanceof HyperframesLayoutError) {
      return { ok: false, reason: cause.message, kind: "layout" };
    }
    if (cause instanceof HyperframesExitError) {
      return { ok: false, reason: cause.message, kind: "exit" };
    }
    if (cause instanceof HyperframesNotFoundError) {
      return { ok: false, reason: cause.message, kind: "spawn" };
    }
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
      kind: "other",
    };
  }
}

// ---------------------------------------------------------------------------
// Tiny argv helpers (lifted verbatim from crm-providers cli.ts)
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
1);
});
