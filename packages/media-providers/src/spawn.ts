// Subprocess helpers for the HyperFrames CLI.
//
// Mirrors the canonical Founder OS Node-side spawn pattern from
// packages/sales-agents/src/node/claude-cli-caller.ts and
// packages/prompt-master/src/transports/claude-cli.ts:
//   - node:child_process.spawn (no cross-spawn, no execa)
//   - stdio ["pipe","pipe","pipe"]
//   - buffered utf8 stdout/stderr
//   - timeout via SIGTERM kill
//   - ENOENT branch tagged with a distinct error class
//
// Windows note: HyperFrames installs as `hyperframes.cmd`. Node's spawn
// handles .cmd shim discovery via PATHEXT, BUT Node 20+ refuses to spawn
// .cmd/.bat files (CVE-2024-24576 / BatBadBut) when args contain shell
// metacharacters (quotes, ampersands, etc.). We dodge that entirely by:
//   1. NEVER passing JSON as a CLI arg -- use --variables-file <path>.
//   2. Keeping all other args metacharacter-free (paths, numbers, enums).
// Callers that need to pass JSON should write it to a temp file first.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface SpawnOpts {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard timeout. Default 120s -- renders can take a while. */
  timeoutMs?: number;
  /** Override the binary name. Default "hyperframes". */
  binary?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class HyperframesNotFoundError extends Error {
  constructor(binary: string) {
    super(
      `hyperframes binary not found (tried "${binary}"). ` +
        `Install with "npm install -g hyperframes" or invoke via "npx hyperframes".`,
    );
    this.name = "HyperframesNotFoundError";
  }
}

export class HyperframesTimeoutError extends Error {
  constructor(args: ReadonlyArray<string>, timeoutMs: number) {
    super(`hyperframes ${args.join(" ")}: timed out after ${timeoutMs}ms`);
    this.name = "HyperframesTimeoutError";
  }
}

export class HyperframesExitError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(args: ReadonlyArray<string>, result: SpawnResult) {
    super(
      `hyperframes ${args.join(" ")}: exit ${result.code} -- ` +
        `${result.stderr.slice(0, 240).trim()}`,
    );
    this.name = "HyperframesExitError";
    this.code = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

/**
 * Run the hyperframes CLI and resolve with stdout/stderr/exit-code.
 * Throws HyperframesNotFoundError on ENOENT, HyperframesTimeoutError on
 * timeout. Non-zero exits resolve normally so callers can branch on
 * `result.code` and inspect stderr (e.g. lint reports findings on stderr
 * even on success).
 */
export function runHyperframes(
  args: ReadonlyArray<string>,
  opts: SpawnOpts = {},
): Promise<SpawnResult> {
  const binary = opts.binary ?? "hyperframes";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(binary, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new HyperframesNotFoundError(binary));
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
      reject(new HyperframesTimeoutError(args, timeoutMs));
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
        reject(new HyperframesNotFoundError(binary));
      } else {
        reject(new Error(`hyperframes spawn failed (${err.message})`));
      }
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    // Close stdin immediately -- HyperFrames CLI is non-interactive by
    // default. If a future command needs stdin input, branch here.
    child.stdin.end();
  });
}

/**
 * Run the CLI with --json output and return the parsed JSON. Throws
 * HyperframesExitError on non-zero exit, throws SyntaxError if stdout
 * isn't valid JSON.
 *
 * Note: many HyperFrames JSON commands (doctor, lint, inspect) intentionally
 * exit 0 even when the underlying check failed -- they carry the failure
 * in the JSON body (e.g. doctor's `ok: false`, lint's `errorCount > 0`).
 * Callers must inspect the returned payload, not just trust exit 0.
 */
export async function runHyperframesJson<T = unknown>(
  args: ReadonlyArray<string>,
  opts: SpawnOpts = {},
): Promise<T> {
  // Make sure --json is in the args, but don't double it.
  const argsWithJson = args.includes("--json") ? args : [...args, "--json"];
  const result = await runHyperframes(argsWithJson, opts);
  if (result.code !== 0) {
    throw new HyperframesExitError(argsWithJson, result);
  }
  return JSON.parse(result.stdout.trim()) as T;
}
