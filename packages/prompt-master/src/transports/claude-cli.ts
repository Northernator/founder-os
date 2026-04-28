/**
 * Reference transport: Claude CLI subprocess.
 *
 * Spawns the Claude Code CLI (`claude -p`) as a one-shot subprocess, feeds
 * the prompt via stdin, captures the optimized output from stdout. Uses
 * whatever auth the CLI itself has (OAuth tokens from `claude login`,
 * subscription mode, etc) - no separate API key needed.
 *
 * Use this in environments that already have Claude CLI installed and
 * authenticated:
 *   - VS Code extensions (founder-cowork, builder-extension)
 *   - CLI tools, build scripts, anywhere Node + the CLI binary are present
 *
 * Setup:
 *   import { setTransport } from "@founder-os/prompt-master";
 *   import { createClaudeCliTransport } from "@founder-os/prompt-master";
 *
 *   setTransport(createClaudeCliTransport({
 *     binary: "claude",          // optional, defaults to "claude" on PATH
 *     timeoutMs: 30_000,         // optional, defaults to 30s
 *   }));
 *
 * The CLI binary is invoked as `claude -p --system-prompt <pm-system>` with
 * the user's prompt piped to stdin. If your install needs different flags,
 * pass `extraArgs` instead of overriding the whole invocation.
 */
import { spawn } from "node:child_process";
import type { OptimizeInput, PromptMasterTransport } from "../types.js";

const PROMPT_MASTER_SYSTEM = `You are Prompt Master, a lossless prompt optimizer.

Your job: rewrite the user's prompt to use fewer tokens while preserving every
instruction, constraint, format requirement, and example. Do NOT drop content.
Do NOT paraphrase examples. Do NOT change meaning.

Output ONLY the optimized prompt. No explanation, no preamble, no metadata.

Rules:
- Use crisp imperative phrasing.
- Collapse redundant phrasing ("please make sure to" -> "must").
- Combine adjacent rules into a single sentence when meaning is preserved.
- Preserve all variable placeholders (e.g. {{name}}, [field]) verbatim.
- Preserve XML tags, code fences, and JSON shape examples verbatim.
- If the input is already minimal, return it unchanged.`;

export interface ClaudeCliTransportOpts {
  /** CLI binary name or absolute path. Default "claude" (must be on PATH). */
  binary?: string;
  /** Override the system prompt. Default is the Prompt Master instruction set. */
  systemOverride?: string;
  /** Hard timeout for the CLI invocation. Default 30s. */
  timeoutMs?: number;
  /**
   * Extra args inserted between the binary and "-p" flag. Use for things
   * like "--model claude-haiku-4-5-20251001" if you want Haiku for the
   * optimization step (cheaper, faster). Default is no extras.
   */
  extraArgs?: string[];
}

export function createClaudeCliTransport(opts: ClaudeCliTransportOpts = {}): PromptMasterTransport {
  const binary = opts.binary ?? "claude";
  const system = opts.systemOverride ?? PROMPT_MASTER_SYSTEM;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const extraArgs = opts.extraArgs ?? [];

  return {
    name: "claude-cli",
    async optimize(input: OptimizeInput): Promise<{ optimized: string }> {
      return new Promise((resolve, reject) => {
        const args = [...extraArgs, "-p", "--system-prompt", system];
        const child = spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // already dead
          }
          reject(new Error(`claude-cli: timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err: Error) => {
          clearTimeout(timer);
          // Most common cause: binary not on PATH.
          reject(new Error(`claude-cli: spawn failed (${err.message})`));
        });
        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`claude-cli: exit ${code ?? "?"} - ${stderr.slice(0, 240).trim()}`));
            return;
          }
          const text = stdout.trim();
          // Defensive: empty output -> identity (core dispatcher marks fallback).
          resolve({ optimized: text.length > 0 ? text : input.prompt });
        });

        // Pipe the prompt to stdin and close it so the CLI knows input is done.
        child.stdin.write(input.prompt);
        child.stdin.end();
      });
    },
  };
}
