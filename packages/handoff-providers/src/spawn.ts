/**
 * Subprocess helper for the Open CoDesign Electron binary.
 *
 * Mirrors the canonical Founder OS Node-side spawn pattern from
 * packages/media-providers/src/spawn.ts and
 * packages/sales-agents/src/node/claude-cli-caller.ts:
 *   - node:child_process.spawn (no cross-spawn, no execa)
 *   - detached: true + child.unref() so CoDesign survives the Tauri
 *     command returning -- this is a UI launcher, not a piped CLI.
 *   - ENOENT branch tagged with a distinct error class.
 *
 * Open CoDesign accepts no documented argv (see docs/research below)
 * and no URL scheme, so the spawn() call is intentionally bare:
 *   spawn(binary, [], { detached: true, stdio: "ignore" })
 *
 * The renderer pre-loads the clipboard with the prompt before invoking
 * the Tauri command that calls this helper. CoDesign opens, the user
 * pastes, generation happens inside CoDesign.
 *
 * Windows note: Open CoDesign's installer ships an `.exe` (NOT a `.cmd`
 * shim) so Node 20+'s BatBadBut restriction does not apply. We pass no
 * args anyway -- the only metacharacter risk is in the binary path
 * itself, which Windows handles natively.
 *
 * docs/research:
 *   https://github.com/OpenCoworkAI/open-codesign (README confirms no
 *   CLI / URL scheme as of v0.2, May 2026)
 */

import { spawn } from "node:child_process";

export interface CodesignSpawnOpts {
  /**
   * Absolute path to the open-codesign executable. Required -- callers
   * resolve it via probeCodesignBinary() first. We don't fall back to
   * PATH here because the launcher is the only sensible caller and it
   * already does the lookup.
   */
  binary: string;
  /**
   * Working directory. Defaults to the parent of `binary` so any
   * relative paths CoDesign resolves at startup land in its own dir.
   */
  cwd?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CodesignSpawnHandle {
  /** Child PID once the spawn callback fires. */
  pid: number;
  /** The binary path we actually invoked. */
  binary: string;
}

export class CodesignNotFoundError extends Error {
  constructor(attempted: string) {
    super(
      `open-codesign binary not found (tried "${attempted}"). ` +
        `Install via "brew install --cask opencoworkai/tap/open-codesign" on macOS, ` +
        `"scoop install opencoworkai/open-codesign" on Windows, ` +
        `or download from https://github.com/OpenCoworkAI/open-codesign/releases.`,
    );
    this.name = "CodesignNotFoundError";
  }
}

export class CodesignSpawnError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "CodesignSpawnError";
    this.cause = cause;
  }
}

/**
 * Spawn Open CoDesign detached. Resolves once the child has a PID
 * (process.spawn() emits this synchronously on success); the launcher
 * itself runs independently and is not awaited.
 *
 * Throws CodesignNotFoundError on ENOENT, CodesignSpawnError on any
 * other spawn failure.
 */
export function spawnCodesign(opts: CodesignSpawnOpts): Promise<CodesignSpawnHandle> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.binary, [], {
        detached: true,
        stdio: "ignore",
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: false,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new CodesignNotFoundError(opts.binary));
        return;
      }
      reject(new CodesignSpawnError(`Failed to spawn ${opts.binary}: ${e.message}`, e));
      return;
    }

    // ENOENT thrown asynchronously on some platforms -- listen for "error"
    // and translate, otherwise the promise hangs.
    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      const e = err as Error & { code?: string };
      if (e.code === "ENOENT") {
        reject(new CodesignNotFoundError(opts.binary));
        return;
      }
      reject(new CodesignSpawnError(`Failed to spawn ${opts.binary}: ${e.message}`, e));
    });

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      // Let the child outlive this process.
      child.unref();
      resolve({
        pid: child.pid ?? -1,
        binary: opts.binary,
      });
    });
  });
}
