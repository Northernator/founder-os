/**
 * Open CoDesign launcher -- binary detection + provider factory.
 *
 * Node-only. Sits under "@founder-os/handoff-providers/node" and is
 * called either from a Tauri command (slice 2: src-tauri/src/codesign.rs)
 * or from the parallel Node CLI in cli.ts. Both call paths return the
 * same HandoffProbeResult / HandoffSpawnResult envelopes (validated with
 * zod when crossing IPC).
 *
 * Detection strategy (cheap on every platform):
 *   1. If opts.binary is set, trust it and stat() to confirm existence.
 *   2. Search PATH for "open-codesign" (Linux/macOS) or
 *      "open-codesign.exe" (Windows).
 *   3. Probe a handful of well-known install locations per OS:
 *        - macOS:   /Applications/Open CoDesign.app/Contents/MacOS/Open CoDesign
 *                   ~/Applications/Open CoDesign.app/Contents/MacOS/Open CoDesign
 *                   $(brew --prefix)/bin/open-codesign  (skipped -- brew shim ends up in PATH)
 *        - Windows: %LOCALAPPDATA%\Programs\open-codesign\open-codesign.exe   (legacy NSIS / scoop-style)
 *                   %LOCALAPPDATA%\Programs\Open CoDesign\Open CoDesign.exe   (NSIS user-scope -- winget default)
 *                   %ProgramFiles%\Open CoDesign\Open CoDesign.exe            (NSIS machine-scope)
 *                   %USERPROFILE%\scoop\shims\open-codesign.exe               (scoop shim)
 *                   %USERPROFILE%\scoop\apps\open-codesign\current\open-codesign.exe
 *        - Linux:   /usr/local/bin/open-codesign
 *                   ~/.local/bin/open-codesign
 *                   ~/Applications/Open*CoDesign*.AppImage
 *
 * Version parsing is best-effort -- CoDesign prints to stdout on
 * `--version`, but we don't actually shell out for it (we'd block the
 * Tauri command on an Electron cold start). If a caller wants version
 * info they can spawn() with --version separately; the probe surface
 * intentionally stays cheap.
 */

import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { createLogger } from "@founder-os/logger";
import {
  spawnCodesign,
  type CodesignSpawnHandle,
} from "./spawn.js";
import type { HandoffProbeResult, HandoffSpawnResult } from "./types.js";

const log = createLogger("handoff-providers:codesign-launcher");

/**
 * Per-platform candidate binary paths. Exported so slice 2's Rust side
 * (and any unit tests) can assert the list is what we expect. Order is
 * preference order -- the first existing file wins.
 */
export const CODESIGN_BINARY_CANDIDATES = {
  darwin: [
    "/Applications/Open CoDesign.app/Contents/MacOS/Open CoDesign",
    join(homedir(), "Applications", "Open CoDesign.app", "Contents", "MacOS", "Open CoDesign"),
  ],
  win32: [
    // Legacy NSIS layout / hyphenated lowercase (kept for forward-compat in
    // case OpenCoworkAI ever ships a CLI-style build).
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Programs",
      "open-codesign",
      "open-codesign.exe",
    ),
    // NSIS user-scope, product-name layout. This is what the Electron
    // installer actually produces, and what `winget install
    // OpenCoworkAI.OpenCoDesign` lands on disk as of v0.2.x.
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Programs",
      "Open CoDesign",
      "Open CoDesign.exe",
    ),
    // NSIS machine-scope ("install for all users" branch of the same NSIS
    // installer).
    join(
      process.env.PROGRAMFILES ?? "C:\\Program Files",
      "Open CoDesign",
      "Open CoDesign.exe",
    ),
    // Scoop shim.
    join(homedir(), "scoop", "shims", "open-codesign.exe"),
    // Scoop direct.
    join(homedir(), "scoop", "apps", "open-codesign", "current", "open-codesign.exe"),
  ],
  linux: [
    "/usr/local/bin/open-codesign",
    "/usr/bin/open-codesign",
    join(homedir(), ".local", "bin", "open-codesign"),
  ],
} as const;

export interface CodesignLauncherOpts {
  /**
   * Override the binary path entirely. When set, probe() trusts it and
   * skips the candidate sweep. Used by tests + power users who keep
   * Open CoDesign in a non-standard location.
   */
  binary?: string;
}

export interface CodesignLauncher {
  /**
   * Resolve whether Open CoDesign is launchable. Cheap -- no subprocess
   * spawn, only fs.stat over the candidate list.
   */
  probe(): Promise<HandoffProbeResult>;
  /**
   * Spawn Open CoDesign detached. Resolves once the child has a PID;
   * the launcher window lives on past this resolution.
   *
   * If probe() previously returned available=false, spawn() returns
   * spawned=false with the same reason string -- it does NOT re-probe.
   * Callers that want fresh state should call probe() again first.
   */
  spawn(): Promise<HandoffSpawnResult>;
}

/**
 * Build a CodesignLauncher. Stateless apart from caching the last
 * probe result so spawn() can short-circuit when the binary is known
 * to be missing.
 */
export function createCodesignLauncher(
  opts: CodesignLauncherOpts = {},
): CodesignLauncher {
  let cachedProbe: HandoffProbeResult | undefined;

  return {
    async probe(): Promise<HandoffProbeResult> {
      cachedProbe = await probeCodesignBinary(opts.binary);
      return cachedProbe;
    },
    async spawn(): Promise<HandoffSpawnResult> {
      const probe = cachedProbe ?? (await probeCodesignBinary(opts.binary));
      cachedProbe = probe;
      if (!probe.available || !probe.path) {
        return {
          engine: "codesign",
          spawned: false,
          error: probe.reason ?? "open-codesign binary not found",
        };
      }
      try {
        const handle = await spawnCodesign({ binary: probe.path });
        log.info(`spawned open-codesign (pid=${handle.pid}) at ${probe.path}`);
        return {
          engine: "codesign",
          spawned: true,
          pid: handle.pid,
          path: handle.binary,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`open-codesign spawn failed: ${message}`);
        return {
          engine: "codesign",
          spawned: false,
          path: probe.path,
          error: message,
        };
      }
    },
  };
}

/**
 * Probe the user's machine for Open CoDesign. Resolves with an
 * envelope-shaped result so callers can return it straight back to the
 * renderer over a Tauri command boundary.
 */
export async function probeCodesignBinary(
  override?: string,
): Promise<HandoffProbeResult> {
  // Explicit override wins.
  if (override && override.trim().length > 0) {
    if (existsAndExecutable(override)) {
      return {
        engine: "codesign",
        available: true,
        path: resolve(override),
        reason: undefined,
      };
    }
    return {
      engine: "codesign",
      available: false,
      reason: `Override path "${override}" does not point to an executable file`,
    };
  }

  // PATH lookup -- cheapest cross-platform option.
  const onPath = findOnPath(platform() === "win32" ? "open-codesign.exe" : "open-codesign");
  if (onPath) {
    return { engine: "codesign", available: true, path: onPath };
  }

  // Per-platform well-known locations.
  const candidates = candidatesForCurrentPlatform();
  for (const candidate of candidates) {
    if (existsAndExecutable(candidate)) {
      return { engine: "codesign", available: true, path: candidate };
    }
  }

  return {
    engine: "codesign",
    available: false,
    reason: "Open CoDesign not found on PATH or in known install dirs",
  };
}

// --- internals -----------------------------------------------------------

function existsAndExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile();
  } catch {
    return false;
  }
}

function candidatesForCurrentPlatform(): ReadonlyArray<string> {
  switch (platform()) {
    case "darwin":
      return CODESIGN_BINARY_CANDIDATES.darwin;
    case "win32":
      return CODESIGN_BINARY_CANDIDATES.win32;
    default:
      return CODESIGN_BINARY_CANDIDATES.linux;
  }
}

/**
 * Lightweight `which` -- scan PATH for the binary name. Used in
 * preference to shelling out to /usr/bin/which so the probe stays
 * synchronous in spirit (no subprocess) and works on Windows.
 */
function findOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  if (pathEnv.length === 0) return undefined;

  const pathExt = platform() === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((s) => s.toLowerCase())
    : [""];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of pathExt) {
      const fullName = ext.length > 0 && !name.toLowerCase().endsWith(ext)
        ? `${name}${ext}`
        : name;
      const candidate = join(dir, fullName);
      if (existsAndExecutable(candidate)) {
        // Normalize -- strip trailing separator from "dir" if any.
        return candidate.replace(new RegExp(`${escapeRegExp(sep)}+$`), "");
      }
    }
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
