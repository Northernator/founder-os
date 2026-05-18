/**
 * Subprocess helpers for `gemini-cli` — the Gemini Advanced channel.
 *
 * Mirrors the canonical Founder OS Node-side spawn pattern from
 * @founder-os/sales-agents/node/claude-cli-caller.ts and
 * @founder-os/media-providers/spawn.ts:
 *   - node:child_process.spawn (no cross-spawn, no execa)
 *   - stdio ["pipe","pipe","pipe"]
 *   - buffered utf8 stdout/stderr
 *   - timeout via SIGTERM kill
 *   - ENOENT branch tagged with a distinct error class (GeminiNotFoundError)
 *
 * Windows note: gemini-cli installs as `gemini.cmd` via npm. Node 20.12+
 * refuses to spawn .cmd/.bat without shell:true when args contain shell
 * metacharacters (CVE-2024-24576 / BatBadBut). The Win CLI memory says
 * to:
 *   1. Resolve PATH × PATHEXT manually to find the shim.
 *   2. Set shell:true only when we land on a .cmd / .bat / .ps1.
 *   3. Pass the prompt via stdin, not as an arg (Gemini supports this).
 *   4. Use `--skip-trust` so the CLI doesn't block on a TTY trust prompt.
 *
 * This file is Node-only — the WebView reaches gemini-sub via a Tauri
 * command. The browser-safe barrel (./index.ts) does not import this.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Manual PATH × PATHEXT resolver for Windows — Node's spawn() without
 * shell:true does not probe PATHEXT, so a bare "gemini" never finds the
 * npm-installed `gemini.cmd`. Lifted from @founder-os/social-providers'
 * spawn.ts (same pattern as media-providers).
 *
 * Returns null when nothing matched; callers fall back to spawning the
 * bare name (which surfaces ENOENT through GeminiNotFoundError so the UI
 * shows the install hint).
 */
function resolveGeminiBinary(
  name: string,
): { path: string; needsShell: boolean } | null {
  if (process.platform !== "win32") {
    return { path: name, needsShell: false };
  }
  const pathexts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(name);
  const shellExts = /\.(cmd|bat|ps1)$/i;

  for (const dir of dirs) {
    if (hasExt) {
      const full = join(dir, name);
      if (existsSync(full)) {
        return { path: full, needsShell: shellExts.test(full) };
      }
      continue;
    }
    for (const ext of pathexts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) {
        return { path: full, needsShell: shellExts.test(full) };
      }
    }
  }
  return null;
}

export interface GeminiSpawnOpts {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard timeout per call. Default 120s — grounded research can be slow. */
  timeoutMs?: number;
  /** Override the binary name. Default "gemini". */
  binary?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Stdin payload (the user prompt). */
  stdin?: string;
}

export interface GeminiSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GeminiNotFoundError extends Error {
  constructor(binary: string) {
    super(
      `gemini-cli binary not found (tried "${binary}"). ` +
        `Install with "npm install -g @google/gemini-cli" and run \`gemini auth\` once.`,
    );
    this.name = "GeminiNotFoundError";
  }
}

export class GeminiTimeoutError extends Error {
  constructor(args: ReadonlyArray<string>, timeoutMs: number) {
    super(`gemini ${args.join(" ")}: timed out after ${timeoutMs}ms`);
    this.name = "GeminiTimeoutError";
  }
}

export class GeminiExitError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(args: ReadonlyArray<string>, result: GeminiSpawnResult) {
    super(
      `gemini ${args.join(" ")}: exit ${result.code} — ${result.stderr
        .slice(0, 240)
        .trim()}`,
    );
    this.name = "GeminiExitError";
    this.code = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

/**
 * Spawn `gemini` with the given args and resolve with the captured
 * stdout/stderr/exit-code. Throws GeminiNotFoundError on ENOENT,
 * GeminiTimeoutError on timeout. Non-zero exits resolve normally so
 * callers can branch on `result.code`.
 *
 * Pass the user prompt via `opts.stdin` — the CLI's `-p`/`--prompt` flag
 * trips Windows shell-quoting on long prompts. stdin is metacharacter-safe.
 */
export function runGemini(
  args: ReadonlyArray<string>,
  opts: GeminiSpawnOpts = {},
): Promise<GeminiSpawnResult> {
  const binary = opts.binary ?? "gemini";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const resolved = resolveGeminiBinary(binary);
  const spawnBinary = resolved?.path ?? binary;
  const needsShell = resolved?.needsShell ?? false;

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(spawnBinary, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        // Node 20.12+ refuses to spawn .cmd/.bat directly (CVE-2024-24576).
        // shell:true only when we resolved to a shim — direct .exe spawns
        // stay shell-free.
        shell: needsShell,
        windowsHide: true,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new GeminiNotFoundError(binary));
        return;
      }
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      reject(new GeminiTimeoutError(args, timeoutMs));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new GeminiNotFoundError(binary));
      } else {
        reject(new Error(`gemini-cli spawn failed (${err.message})`));
      }
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (opts.stdin && opts.stdin.length > 0) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/**
 * Probe whether `gemini --version` succeeds. Used by gemini-sub's
 * `available()` so the orchestrator doesn't pick this channel when the
 * CLI isn't installed. 5s timeout — `--version` should be near-instant.
 */
export async function isGeminiCliAvailable(binary = "gemini"): Promise<boolean> {
  return new Promise((resolve) => {
    const resolved = resolveGeminiBinary(binary);
    const spawnBinary = resolved?.path ?? binary;
    const needsShell = resolved?.needsShell ?? false;
    let child: ChildProcessByStdio<Writable, null, null>;
    try {
      child = spawn(spawnBinary, ["--version"], {
        stdio: ["pipe", "ignore", "ignore"],
        shell: needsShell,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}
