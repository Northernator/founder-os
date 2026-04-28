/**
 * Generic CLI-backed handoff runner. One factory used by all 6
 * HandoffRequestType handlers - the only thing that differs between them
 * is the system prompt and the convention of where to write artifacts.
 *
 * Why CLI subprocess instead of the Anthropic SDK?
 *   - Uses whatever auth the Claude CLI has (OAuth tokens from
 *     `claude login`, subscription mode, etc) - no separate API key needed
 *   - Same auth surface as everything else in the app
 *   - No vendor SDK bundled into the extension build
 *
 * Streams stdout as it arrives so progress events fire while the model
 * generates. Falls back gracefully on a non-zero exit.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@founder-os/logger";
import { optimize } from "@founder-os/prompt-master";
import { readSharedConfig } from "@founder-os/prompt-master/node";
import type {
  HandoffBundle,
  HandoffResult,
} from "@founder-os/handoff-contract";
import {
  makeSuccessResult,
  makeFailureResult,
  type ProgressCallback,
} from "@founder-os/handoff-vscode";

const log = createLogger("founder-cowork:handoff-sdk-runner");

export interface RunHandoffOptions {
  bundle: HandoffBundle;
  ventureRoot: string;
  /** Claude CLI binary. Default "claude" (must be on PATH). */
  claudeBinary?: string;
  systemPrompt: string;
  /** Sub-folder inside the venture root where extracted files land. */
  outputSubdir?: string;
  /** Override Claude model. Default claude-opus-4-6. */
  model?: string;
  /** Max tokens. Default 8192. */
  maxTokens?: number;
  /** Hard timeout for the CLI invocation. Default 5 minutes. */
  timeoutMs?: number;
  onProgress: ProgressCallback;
}

export async function runHandoffWithSdk(
  opts: RunHandoffOptions,
): Promise<HandoffResult> {
  const {
    bundle,
    ventureRoot,
    claudeBinary = "claude",
    systemPrompt,
    outputSubdir = "",
    model = "claude-opus-4-6",
    maxTokens = 8192,
    timeoutMs = 5 * 60 * 1000,
    onProgress,
  } = opts;

  log.info(
    "runHandoffWithSdk(" + bundle.type + ") starting for run " + bundle.runId,
  );

  emit(onProgress, bundle.runId, 10, "Preparing context...");

  const contextParts: string[] = [
    "## Handoff Bundle\n```json\n" +
      JSON.stringify(bundle.payload, null, 2) +
      "\n```",
  ];

  for (const ref of bundle.artifactRefs) {
    const absPath = path.join(ventureRoot, ref.path);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath, "utf-8");
        contextParts.push(
          "## Artifact: " + ref.type + " (" + ref.path + ")\n```\n" +
            content +
            "\n```",
        );
      } catch (e) {
        log.warn("Couldn't read artifact " + ref.path + ": " + String(e));
      }
    }
  }

  emit(onProgress, bundle.runId, 20, "Sending to Claude...");

  // Optimize the system prompt before sending. optimize() never throws --
  // when no transport is registered or the upstream fails, it returns the
  // original prompt with fallbackUsed=true.
  const { optimized: optimizedSystem, tokensSaved } = await optimize({
    prompt: systemPrompt,
    context: "handoff",
    model,
  });
  if (tokensSaved > 0) {
    log.info("prompt-master saved ~" + tokensSaved + " tokens on system prompt");
  }

  const userPrompt = contextParts.join("\n\n");

  let fullResponse: string;
  try {
    fullResponse = await spawnClaude({
      binary: claudeBinary,
      systemPrompt: optimizedSystem,
      userPrompt,
      model,
      maxTokens,
      timeoutMs,
      onProgress: (pct, msg) => emit(onProgress, bundle.runId, pct, msg),
    });
  } catch (err) {
    log.error("Claude CLI error: " + String(err));
    return makeFailureResult(bundle, "Claude CLI error: " + String(err));
  }

  emit(onProgress, bundle.runId, 95, "Writing artifacts...");

  const producedPaths = writeCodeBlocks(fullResponse, ventureRoot, outputSubdir);

  emit(onProgress, bundle.runId, 100, "Done");

  return makeSuccessResult(
    bundle,
    producedPaths.map((p) => ({
      artifactId: bundle.ventureId + "::" + p,
      path: p,
      type: "file",
    })),
    "Run " + bundle.runId + " (" + bundle.type + ") complete. " +
      producedPaths.length + " files produced.",
  );
}

// --------------------------------------------------
// Claude CLI subprocess helper
// --------------------------------------------------

interface SpawnClaudeOpts {
  binary: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  onProgress: (pct: number, msg: string) => void;
}

/**
 * Parse one or more ndjson lines from claude -p --output-format stream-json.
 * Returns the concatenated text emitted by the assistant in those lines.
 * Incomplete lines (no trailing newline) get buffered for the next call.
 *
 * Event shape we care about:
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *
 * Other event types (system init, tool_use, result) are silently skipped.
 */
function parseStreamJsonChunk(buffer: string, chunk: string): { text: string; remaining: string } {
  const combined = buffer + chunk;
  const lines = combined.split("\n");
  const remaining = lines.pop() ?? "";
  let text = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
    } catch {
      // Malformed line - skip silently; the CLI occasionally emits status
      // lines on stderr that aren't strict ndjson.
    }
  }
  return { text, remaining };
}

function spawnClaude(opts: SpawnClaudeOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const cfg = readSharedConfig().promptMaster;
    const streaming = cfg.streamingProgress;

    // Streaming mode parses ndjson assistant events for fine-grained progress.
    // Default mode just collects stdout chunks for a coarser fixed-step progress.
    const args = streaming
      ? [
          "-p",
          "--system-prompt", opts.systemPrompt,
          "--model", opts.model,
          "--max-turns", "1",
          "--output-format", "stream-json",
          "--verbose",
        ]
      : [
          "-p",
          "--system-prompt", opts.systemPrompt,
          "--model", opts.model,
          "--max-turns", "1",
        ];

    const child = spawn(opts.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let streamBuffer = "";
    let accumulated = "";
    let lastPct = 20;

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      reject(new Error("claude CLI timed out after " + opts.timeoutMs + "ms"));
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (streaming) {
        const parsed = parseStreamJsonChunk(streamBuffer, text);
        streamBuffer = parsed.remaining;
        if (parsed.text.length > 0) {
          accumulated += parsed.text;
          // Token-aware progress: assume average 8KB target output, scale
          // linearly. Caps at 90% so we leave room for the final "writing
          // artifacts" step.
          const pct = Math.min(90, 20 + Math.floor((accumulated.length / 8192) * 70));
          if (pct > lastPct) {
            lastPct = pct;
            opts.onProgress(pct, "Generating...");
          }
        }
      } else {
        // Non-streaming: bump 5% per chunk, capped at 90%.
        lastPct = Math.min(90, lastPct + 5);
        opts.onProgress(lastPct, "Generating...");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error("claude CLI spawn failed: " + err.message));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            "claude CLI exit " + (code ?? "?") + " - " +
              stderr.slice(0, 240).trim(),
          ),
        );
        return;
      }
      // Streaming mode returns the parsed text; non-streaming returns raw stdout.
      resolve(streaming ? accumulated : stdout);
    });

    child.stdin.write(opts.userPrompt);
    child.stdin.end();
  });
}

// --------------------------------------------------
// Helpers (exported for test)
// --------------------------------------------------

/**
 * Pull every fenced code block whose info string looks like a relative file
 * path (contains a `.` or `/`) and write it. Plain language tags like
 * `json`, `typescript`, `bash` are skipped.
 */
export function writeCodeBlocks(
  response: string,
  ventureRoot: string,
  outputSubdir: string,
): string[] {
  const written: string[] = [];
  const skipTags = new Set([
    "json", "typescript", "javascript", "ts", "js", "tsx", "jsx",
    "bash", "sh", "shell", "powershell", "ps1", "yaml", "yml",
    "html", "css", "md", "markdown", "text", "txt",
  ]);

  const fenceRegex = /```([^\s`]+)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(response)) !== null) {
    const tag = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!tag || skipTags.has(tag.toLowerCase())) continue;
    if (!tag.includes(".") && !tag.includes("/")) continue;

    const relPath = path.join(outputSubdir, tag);
    const absPath = path.join(ventureRoot, relPath);
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, body, "utf-8");
      written.push(relPath.split(path.sep).join("/"));
      log.info("Wrote: " + absPath);
    } catch (err) {
      log.warn("Failed to write " + absPath + ": " + String(err));
    }
  }
  return written;
}

function emit(
  cb: ProgressCallback,
  runId: string,
  percentComplete: number,
  message: string,
): void {
  cb({
    runId,
    status: percentComplete < 100 ? "running" : "success",
    message,
    percentComplete,
    emittedAt: new Date().toISOString(),
  });
}
