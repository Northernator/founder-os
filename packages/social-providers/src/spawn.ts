// Subprocess helpers for the social-poster CLI (`sp`).
//
// Mirrors the canonical Founder OS Node-side spawn pattern from
// packages/media-providers/src/spawn.ts and
// packages/backend-providers/src/spawn.ts:
//   - node:child_process.spawn (no cross-spawn, no execa)
//   - stdio ["pipe","pipe","pipe"]
//   - buffered utf8 stdout/stderr
//   - timeout via SIGTERM kill
//   - ENOENT branch tagged with a distinct error class
//
// Windows note: social-poster installs as `sp.cmd`. Node's spawn handles
// .cmd shim discovery via PATHEXT, BUT Node 20+ refuses to spawn
// .cmd/.bat files (CVE-2024-24576 / BatBadBut) when args contain shell
// metacharacters (quotes, ampersands, etc.). We dodge that by:
//   1. Keeping all args metacharacter-free -- text + paths only.
//   2. Encoding any caption that contains shell metacharacters by
//      writing it to a temp file and passing --text-file <path> instead.
// The post-time argv builder in social-poster-provider.ts handles this.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Windows binary resolver.
//
// Node's spawn() WITHOUT shell:true does not probe PATHEXT on Windows, so a
// bare "sp" never finds the npm-installed `sp.cmd`. Worse, Node 20.12+ refuses
// to spawn .cmd / .bat shims at all unless shell:true is also set
// (CVE-2024-24576 / BatBadBut). We solve both by manually walking PATH x
// PATHEXT here and reporting whether the resolved file needs a shell wrapper.
//
// Mirrors the canonical Founder OS Windows-CLI pattern (per the "Win CLI"
// auto-memory): PATH probing + PATHEXT order + shell:true only when we land
// on a shim. Direct .exe spawns stay shell-free.
//
// Returns null when nothing matched; callers fall back to spawning the bare
// name (which will surface ENOENT through the normal SocialPosterNotFoundError
// path so the UI shows the install hint).
// ---------------------------------------------------------------------------
function resolveSocialPosterBinary(
  name: string,
): { path: string; needsShell: boolean } | null {
  if (process.platform !== "win32") {
    // POSIX: spawn() walks PATH on its own and shims aren't a concept.
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


export interface SocialPosterSpawnOpts {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard timeout. Default 5min -- video uploads can take a while. */
  timeoutMs?: number;
  /** Override the binary name. Default "sp". */
  binary?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SocialPosterSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Injectable spawn shape -- production code uses spawnSp directly; tests
 * pass a stubbed implementation that returns canned stdout/stderr/code
 * without ever invoking node:child_process. Keeps the test suite hermetic.
 */
export type SpawnLike = (
  args: ReadonlyArray<string>,
  opts?: SocialPosterSpawnOpts
) => Promise<SocialPosterSpawnResult>;

export class SocialPosterNotFoundError extends Error {
  constructor(binary: string) {
    super(
      `social-poster binary not found (tried "${binary}"). ` +
        `Install with "npm install -g @profullstack/social-poster" or ` +
        `invoke via "npx @profullstack/social-poster".`
    );
    this.name = "SocialPosterNotFoundError";
  }
}

export class SocialPosterTimeoutError extends Error {
  constructor(args: ReadonlyArray<string>, timeoutMs: number) {
    super(`sp ${args.join(" ")}: timed out after ${timeoutMs}ms`);
    this.name = "SocialPosterTimeoutError";
  }
}

export class SocialPosterExitError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(args: ReadonlyArray<string>, result: SocialPosterSpawnResult) {
    super(
      `sp ${args.join(" ")}: exit ${result.code} -- ` +
        `${result.stderr.slice(0, 240).trim()}`
    );
    this.name = "SocialPosterExitError";
    this.code = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

/**
 * Run the `sp` CLI and resolve with stdout/stderr/exit-code. Throws
 * SocialPosterNotFoundError on ENOENT, SocialPosterTimeoutError on
 * timeout. Non-zero exits resolve normally so callers can branch on
 * `result.code` and inspect stderr (e.g. sp may report partial-success
 * with non-zero exit when one of N platforms failed).
 */
export function spawnSp(
  args: ReadonlyArray<string>,
  opts: SocialPosterSpawnOpts = {}
): Promise<SocialPosterSpawnResult> {
  const binary = opts.binary ?? "sp";
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  // Resolve the binary up-front so Windows .cmd shims (sp.cmd, sp.ps1) work
  // post-BatBadBut. On POSIX this is a no-op pass-through.
  const resolved = resolveSocialPosterBinary(binary);
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
        // We opt into shell:true only when we actually resolved to a shim --
        // direct .exe spawns stay shell-free.
        shell: needsShell,
        windowsHide: true,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new SocialPosterNotFoundError(binary));
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
        // already dead
      }
      reject(new SocialPosterTimeoutError(args, timeoutMs));
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
        reject(new SocialPosterNotFoundError(binary));
      } else {
        reject(new Error(`sp spawn failed (${err.message})`));
      }
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    // Close stdin immediately -- sp is non-interactive when invoked with
    // --json. Login flows (sp login <platform>) are NEVER spawned by the
    // adapter; they live in the user's terminal.
    child.stdin.end();
  });
}

/**
 * Run the CLI with --json output and return the parsed JSON. Throws
 * SocialPosterExitError on non-zero exit, throws SyntaxError if stdout
 * isn't valid JSON.
 *
 * Note: sp with --json prints structured rows even on partial failure
 * (one platform succeeded, another timed out). Callers must inspect the
 * returned payload, not just trust exit 0.
 */
export async function spawnSpJson<T = unknown>(
  args: ReadonlyArray<string>,
  opts: SocialPosterSpawnOpts = {}
): Promise<T> {
  const argsWithJson = args.includes("--json") ? args : [...args, "--json"];
  const result = await spawnSp(argsWithJson, opts);
  if (result.code !== 0) {
    throw new SocialPosterExitError(argsWithJson, result);
  }
  return JSON.parse(result.stdout.trim()) as T;
}
