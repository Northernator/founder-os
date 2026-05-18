/**
 * Minimal Docker CLI spawn helpers, mirroring the
 * @founder-os/media-providers/spawn.ts conventions (PATH probe, PATHEXT
 * order on Windows, JSON-parsed result envelope).
 *
 * Slice 2 ships the spawn surface so frappe-docker-provider has something
 * to call; slice 7 fills in the real bootstrap orchestration (compose
 * write, up -d, wait-for-ping, install-app crm, generate_keys).
 *
 * Windows note: docker CLI is `docker.exe` on Windows, `docker` on Linux/macOS.
 * spawn's raw_arg handling for .cmd shims doesn't apply here -- the Docker
 * CLI is a native binary on all three OSes. This package therefore does NOT
 * carry the PATHEXT + needsShell resolver that @founder-os/social-providers
 * and @founder-os/media-providers ship for their .cmd-shim CLIs
 * (CVE-2024-24576 / BatBadBut workaround). If a future CRM provider adds a
 * Node-installed CLI on Windows, lift `resolveHyperframesBinary` from
 * @founder-os/media-providers/src/spawn.ts into here too.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DockerNotFoundError extends Error {
  override readonly name = "DockerNotFoundError";
  constructor() {
    super(
      "Docker CLI not found on PATH. Install Docker Desktop (Windows/macOS) " +
        "or Docker Engine (Linux) and ensure `docker` is reachable."
    );
  }
}

export class DockerExitError extends Error {
  override readonly name = "DockerExitError";
  constructor(
    readonly command: string,
    readonly args: ReadonlyArray<string>,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`docker ${args.join(" ")} exited with code ${exitCode}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DockerSpawnOpts = {
  args: ReadonlyArray<string>;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Optional injected spawn (tests use this). Defaults to node:child_process
   * spawn.
   */
  spawnImpl?: typeof spawn;
};

export type DockerSpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnDocker(opts: DockerSpawnOpts): Promise<DockerSpawnResult> {
  const spawner = opts.spawnImpl ?? spawn;

  return await new Promise<DockerSpawnResult>((resolve, reject) => {
    let child;
    try {
      child = spawner("docker", [...opts.args], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      if (isEnoent(cause)) {
        reject(new DockerNotFoundError());
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
        reject(new DockerNotFoundError());
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
 * Convenience wrapper: spawn + JSON.parse(stdout). Throws DockerExitError
 * if exitCode != 0, otherwise returns the parsed JSON cast to T.
 */
export async function spawnDockerJson<T = unknown>(opts: DockerSpawnOpts): Promise<T> {
  const res = await spawnDocker(opts);
  if (res.exitCode !== 0) {
    throw new DockerExitError("docker", opts.args, res.exitCode, res.stdout, res.stderr);
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
