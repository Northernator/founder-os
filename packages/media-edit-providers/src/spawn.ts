// Subprocess helpers for the OpenCut self-hosted provider.
//
// Mirrors the canonical Founder OS Node-side spawn pattern from
// packages/media-providers/src/spawn.ts and
// packages/sales-agents/src/node/claude-cli-caller.ts:
//   - node:child_process.spawn (no cross-spawn, no execa)
//   - stdio ["pipe","pipe","pipe"]
//   - buffered utf8 stdout/stderr
//   - timeout via SIGTERM kill
//   - ENOENT branch tagged with a distinct error class
//
// OpenCut runs via `bun dev` (Next.js 15 + Turbopack). The dev server is
// LONG-RUNNING -- it stays up until teardown() SIGTERMs it. This module
// exposes two distinct spawn shapes:
//
//   - runBun(args, opts) -- one-shot exec (version probe, install). Resolves
//     when the process exits.
//   - spawnBunDev(opts) -- long-running spawn. Resolves when the server
//     prints its "Ready" banner on stdout; returns the child handle so the
//     caller can teardown later. Times out if the server never reports ready.
//
// Windows note: bun installs as `bun.exe` (real PE binary) on Windows --
// NOT a .cmd shim, unlike npm-installed CLIs. This means we can pass args
// freely without the BatBadBut workaround we needed for hyperframes.

import {
  type ChildProcessByStdio,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

// --- Error classes -----------------------------------------------------

export class BunNotFoundError extends Error {
  constructor(binary: string) {
    super(
      `bun runtime not found (tried "${binary}"). ` +
        `Install from https://bun.sh -- on macOS/Linux: \`curl -fsSL https://bun.sh/install | bash\`; ` +
        `on Windows: \`powershell -c "irm bun.sh/install.ps1 | iex"\`.`,
    );
    this.name = "BunNotFoundError";
  }
}

export class BunTimeoutError extends Error {
  constructor(args: ReadonlyArray<string>, timeoutMs: number) {
    super(`bun ${args.join(" ")}: timed out after ${timeoutMs}ms`);
    this.name = "BunTimeoutError";
  }
}

export class BunExitError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(args: ReadonlyArray<string>, code: number, stdout: string, stderr: string) {
    super(`bun ${args.join(" ")}: exit ${code} -- ${stderr.slice(0, 240).trim()}`);
    this.name = "BunExitError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// --- One-shot exec -----------------------------------------------------

export interface RunBunOpts {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard timeout. Default 30s -- one-shot commands should be fast. */
  timeoutMs?: number;
  /** Override the binary name. Default "bun". */
  binary?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface RunBunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run `bun <args>` once and resolve with stdout/stderr/exit-code. Throws
 * BunNotFoundError on ENOENT, BunTimeoutError on timeout. Non-zero exits
 * resolve normally so callers can branch on `result.code`.
 */
export function runBun(
  args: ReadonlyArray<string>,
  opts: RunBunOpts = {},
): Promise<RunBunResult> {
  const binary = opts.binary ?? "bun";
  const timeoutMs = opts.timeoutMs ?? 30_000;

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
        reject(new BunNotFoundError(binary));
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
      reject(new BunTimeoutError(args, timeoutMs));
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
        reject(new BunNotFoundError(binary));
      } else {
        reject(new Error(`bun spawn failed (${err.message})`));
      }
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    child.stdin.end();
  });
}

// --- Long-running dev server ------------------------------------------

export interface SpawnBunDevOpts {
  /** Absolute path to the vendored OpenCut clone (must contain package.json). */
  cwd: string;
  /** Port the dev server should listen on. Default 3000. */
  port?: number;
  /**
   * Pattern in stdout that signals the server is ready. Default matches
   * Next.js 15 / Turbopack readiness lines:
   *   - "Ready in 1.2s"
   *   - "Local:    http://localhost:3000"
   *   - "ready started server"
   */
  readyPattern?: RegExp;
  /** Timeout for the readiness wait. Default 60s. */
  readyTimeoutMs?: number;
  /** Override the binary name. Default "bun". */
  binary?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnBunDevResult {
  /** The spawned child. Keep a reference so teardown() can kill it. */
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  /** PID of the child. */
  pid: number;
  /** Captured stdout so far when the ready pattern matched. */
  readyStdout: string;
}

const DEFAULT_READY_PATTERN =
  /(?:Ready in|ready started server|Local:\s+http:\/\/localhost)/i;

/**
 * Spawn `bun dev` in the vendored OpenCut dir and resolve once the
 * server reports "Ready". Returns the child handle so the caller can
 * SIGTERM it during teardown.
 */
export function spawnBunDev(opts: SpawnBunDevOpts): Promise<SpawnBunDevResult> {
  const binary = opts.binary ?? "bun";
  const port = opts.port ?? 3000;
  const readyPattern = opts.readyPattern ?? DEFAULT_READY_PATTERN;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Force the port Next.js binds to.
        PORT: String(port),
        ...(opts.env ?? {}),
      },
      detached: false,
    };

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(binary, ["dev"], spawnOpts) as ChildProcessByStdio<
        Writable,
        Readable,
        Readable
      >;
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new BunNotFoundError(binary));
        return;
      }
      reject(err);
      return;
    }

    if (typeof child.pid !== "number") {
      reject(new Error("bun dev spawn returned no pid"));
      return;
    }

    let stdoutBuffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      reject(new BunTimeoutError(["dev"], readyTimeoutMs));
    }, readyTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuffer += text;
      if (!settled && readyPattern.test(stdoutBuffer)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          pid: child.pid as number,
          readyStdout: stdoutBuffer,
        });
      }
    });
    child.stderr.on("data", () => {
      // bun dev writes some non-fatal warnings to stderr; ignore them.
      // The readiness signal lives on stdout.
    });
    child.on("error", (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new BunNotFoundError(binary));
      } else {
        reject(new Error(`bun dev spawn failed (${err.message})`));
      }
    });
    child.on("close", (code: number | null) => {
      if (settled) {
        // Closed after we already resolved -- the caller should have
        // gotten the handle and is responsible for restart on crash.
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new BunExitError(["dev"], code ?? -1, stdoutBuffer, ""));
    });

    // No stdin -- bun dev is non-interactive.
    child.stdin.end();
  });
}

// --- Browser opening --------------------------------------------------

export interface OpenInBrowserOpts {
  /** Override the OS open command (for tests). */
  openImpl?: (url: string) => Promise<void>;
}

/**
 * Open a URL in the OS default browser. Cross-platform: uses `open` on
 * macOS, `xdg-open` on Linux, `start` via cmd on Windows. Best-effort:
 * resolves even on failure -- the founder can navigate manually if the
 * OS handler isn't available.
 */
export async function openInBrowser(
  url: string,
  opts: OpenInBrowserOpts = {},
): Promise<boolean> {
  if (opts.openImpl) {
    try {
      await opts.openImpl(url);
      return true;
    } catch {
      return false;
    }
  }
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
