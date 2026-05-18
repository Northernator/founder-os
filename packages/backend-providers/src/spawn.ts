/**
 * Minimal PocketBase binary spawn helpers, mirroring the
 * @founder-os/media-providers/spawn.ts and @founder-os/crm-providers/spawn.ts
 * conventions (PATH probe via explicit binaryPath, JSON-parsed result
 * envelope, optional spawn injection for tests).
 *
 * PocketBase ships as a per-venture native binary (not on PATH), so the
 * caller passes the absolute binaryPath. The provider resolves that via
 * resolveBinaryPath from binary.ts. No PATHEXT / raw_arg dance is needed
 * since PB is a single native binary on every platform (.exe on Windows,
 * plain on Linux/macOS).
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PocketbaseNotFoundError extends Error {
  override readonly name = "PocketbaseNotFoundError";
  constructor(readonly binaryPath: string) {
    super(
      `PocketBase binary not found at ${binaryPath}. Slice 4 ships the auto-download; ` +
        "for now drop a release binary from github.com/pocketbase/pocketbase/releases " +
        "into the venture's 12_backend/pocketbase/ directory."
    );
  }
}

export class PocketbaseExitError extends Error {
  override readonly name = "PocketbaseExitError";
  constructor(
    readonly args: ReadonlyArray<string>,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`pocketbase ${args.join(" ")} exited with code ${exitCode}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PocketbaseSpawnOpts = {
  binaryPath: string;
  args: ReadonlyArray<string>;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Optional injected spawn (tests use this). Defaults to node:child_process
   * spawn.
   */
  spawnImpl?: typeof spawn;
};

export type PocketbaseSpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnPocketbase(
  opts: PocketbaseSpawnOpts
): Promise<PocketbaseSpawnResult> {
  const spawner = opts.spawnImpl ?? spawn;

  return await new Promise<PocketbaseSpawnResult>((resolve, reject) => {
    let child;
    try {
      child = spawner(opts.binaryPath, [...opts.args], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      if (isEnoent(cause)) {
        reject(new PocketbaseNotFoundError(opts.binaryPath));
        return;
      }
      reject(cause);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (isEnoent(err)) {
        reject(new PocketbaseNotFoundError(opts.binaryPath));
        return;
      }
      reject(err);
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve({ exitCode: null, stdout, stderr });
      }, opts.timeoutMs);
    }
  });
}

/**
 * Convenience wrapper: spawn + JSON.parse(stdout). Throws PocketbaseExitError
 * if exitCode != 0, otherwise returns the parsed JSON cast to T. Returns
 * {} for an empty stdout (some PB subcommands print nothing on success).
 */
export async function spawnPocketbaseJson<T = unknown>(
  opts: PocketbaseSpawnOpts
): Promise<T> {
  const res = await spawnPocketbase(opts);
  if (res.exitCode !== 0) {
    throw new PocketbaseExitError(opts.args, res.exitCode, res.stdout, res.stderr);
  }
  const trimmed = res.stdout.trim();
  if (!trimmed) return {} as T;
  return JSON.parse(trimmed) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
