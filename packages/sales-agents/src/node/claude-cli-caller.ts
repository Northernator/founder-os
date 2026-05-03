/**
 * createClaudeCliCallLlm -- zero-auth CallLlm via the Claude Code CLI.
 *
 * Spawns `claude -p --system-prompt <system>` as a one-shot subprocess,
 * pipes the user prompt to stdin, captures stdout as the response.
 * Reuses whatever auth the CLI itself has (OAuth tokens from
 * `claude login`, subscription mode) -- no separate API key needed.
 *
 * This mirrors the spawn pattern in @founder-os/prompt-master's
 * createClaudeCliTransport (transports/claude-cli.ts) which is the
 * canonical Founder OS Node-side LLM mechanism (used by the cowork
 * extension and builder extension).
 *
 * Use when:
 *   - You have Claude Code CLI installed and `claude login` was run
 *   - You're running from a Node CLI / sidecar / VS Code extension
 *   - You want zero-auth ergonomics (no env vars, no key files)
 *
 * Fall back to an API-key-based caller (e.g. @anthropic-ai/sdk) if
 * the user does not have Claude CLI -- the CLI entrypoint handles
 * the picker.
 */

import { spawn } from "node:child_process";

import type { CallLlm } from "../types.js";

export interface ClaudeCliCallerOpts {
  /** CLI binary name or absolute path. Default "claude" (must be on PATH). */
  binary?: string;
  /** Hard timeout per call. Default 90s -- agents do real work, not just optimization. */
  timeoutMs?: number;
  /**
   * Extra args inserted between binary and "-p". Use for model overrides
   * e.g. ["--model", "claude-haiku-4-5-20251001"]. Default none.
   */
  extraArgs?: string[];
}

export class ClaudeCliNotFoundError extends Error {
  constructor(binary: string, cause: string) {
    super(`claude-cli not available (tried "${binary}"): ${cause}`);
    this.name = "ClaudeCliNotFoundError";
  }
}

/**
 * Build a CallLlm that shells out to Claude Code CLI. Returns a function
 * matching the CallLlm contract -- `({system, user}) => Promise<string>`.
 */
export function createClaudeCliCallLlm(opts: ClaudeCliCallerOpts = {}): CallLlm {
  const binary = opts.binary ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const extraArgs = opts.extraArgs ?? [];

  return async ({ system, user }) => {
    return new Promise<string>((resolve, reject) => {
      const args = [...extraArgs, "-p", "--system-prompt", system];
      const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        reject(new Error(`claude-cli: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

      child.on("error", (err: Error & { code?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // ENOENT = binary not on PATH -- tag distinctly so the CLI can fall back.
        if (err.code === "ENOENT") {
          reject(new ClaudeCliNotFoundError(binary, "binary not found on PATH"));
        } else {
          reject(new Error(`claude-cli: spawn failed (${err.message})`));
        }
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude-cli: exit ${code ?? "?"} -- ${stderr.slice(0, 240).trim()}`));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          reject(new Error("claude-cli: empty stdout"));
          return;
        }
        resolve(text);
      });

      child.stdin.write(user);
      child.stdin.end();
    });
  };
}

/**
 * Probe whether the Claude CLI binary is callable. Resolves true if a
 * trivial `claude --version` call succeeds within 5s, false on ENOENT
 * or non-zero exit. Used by the CLI entrypoint to pick caller upfront
 * with a clear error message instead of failing on the first agent.
 */
export async function isClaudeCliAvailable(binary = "claude"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve(false);
    }, 5_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
