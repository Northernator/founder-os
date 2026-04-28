/**
 * BuildRunner — code-gen handoff via Claude CLI subprocess.
 *
 * Spawns `claude -p` with the user's existing CLI auth (OAuth from
 * `claude login`, subscription mode, etc). No separate API key required.
 * The CLI binary defaults to "claude" but is configurable.
 *
 * Streams stdout as it arrives so progress events fire while the model
 * generates. Falls back gracefully on a non-zero exit.
 */
import { spawn } from "node:child_process";
import { createLogger } from "@founder-os/logger";
import type { HandoffBundle, HandoffResult, HandoffProgressEvent } from "@founder-os/handoff-contract";
import { makeSuccessResult, makeFailureResult } from "@founder-os/handoff-vscode";
import { HANDOFF_SYSTEM_PROMPT } from "@founder-os/prompts";
import { optimize } from "@founder-os/prompt-master";
import { readSharedConfig } from "@founder-os/prompt-master/node";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createLogger("builder-extension:build-runner");

export type ProgressCallback = (evt: HandoffProgressEvent) => void;


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
      // Malformed line - skip silently.
    }
  }
  return { text, remaining };
}

export class BuildRunner {
  constructor(
    private bundle: HandoffBundle,
    private ventureRoot: string,
    /** Claude CLI binary name or absolute path. Default "claude" (must be on PATH). */
    private claudeBinary: string,
    private onProgress: ProgressCallback,
  ) {}

  async run(): Promise<HandoffResult> {
    const { bundle, ventureRoot } = this;
    log.info(`BuildRunner starting for run ${bundle.runId}`);

    this.emit(10, "Preparing context...");

    const contextParts: string[] = [
      `## Handoff Bundle\n\`\`\`json\n${JSON.stringify(bundle.payload, null, 2)}\n\`\`\``,
    ];

    for (const ref of bundle.artifactRefs) {
      const absPath = path.join(ventureRoot, ref.path);
      if (fs.existsSync(absPath)) {
        const content = fs.readFileSync(absPath, "utf-8");
        contextParts.push(`## Artifact: ${ref.type} (${ref.path})\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    this.emit(20, "Sending to Claude...");

    const { optimized: optimizedSystem, tokensSaved } = await optimize({
      prompt: HANDOFF_SYSTEM_PROMPT,
      context: "handoff",
      model: "claude-opus-4-6",
    });
    if (tokensSaved > 0) {
      log.info(`prompt-master saved ~${tokensSaved} tokens on system prompt`);
    }

    const userPrompt = contextParts.join("\n\n");

    let fullResponse: string;
    try {
      fullResponse = await this.spawnClaude(optimizedSystem, userPrompt);
    } catch (err) {
      log.error(`Claude CLI error: ${err}`);
      return makeFailureResult(bundle, `Claude CLI error: ${err}`);
    }

    this.emit(95, "Writing artifacts...");

    const producedPaths = this.writeCodeBlocks(fullResponse, ventureRoot);

    this.emit(100, "Done");

    return makeSuccessResult(
      bundle,
      producedPaths.map((p) => ({
        artifactId: `${bundle.ventureId}::${p}`,
        path: p,
        type: "file",
      })),
      `Run ${bundle.runId} complete. ${producedPaths.length} files produced.`,
    );
  }

  private spawnClaude(system: string, userPrompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const cfg = readSharedConfig().promptMaster;
      const streaming = cfg.streamingProgress;

      const args = streaming
        ? [
            "-p",
            "--system-prompt", system,
            "--model", "claude-opus-4-6",
            "--max-turns", "1",
            "--output-format", "stream-json",
            "--verbose",
          ]
        : [
            "-p",
            "--system-prompt", system,
            "--model", "claude-opus-4-6",
            "--max-turns", "1",
          ];

      const child = spawn(this.claudeBinary, args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let streamBuffer = "";
      let accumulated = "";
      let lastPct = 20;

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* dead */ }
        reject(new Error("claude CLI timed out after 5 minutes"));
      }, 5 * 60 * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (streaming) {
          const parsed = parseStreamJsonChunk(streamBuffer, text);
          streamBuffer = parsed.remaining;
          if (parsed.text.length > 0) {
            accumulated += parsed.text;
            const pct = Math.min(90, 20 + Math.floor((accumulated.length / 8192) * 70));
            if (pct > lastPct) {
              lastPct = pct;
              this.emit(pct, "Generating...");
            }
          }
        } else {
          lastPct = Math.min(90, lastPct + 5);
          this.emit(lastPct, "Generating...");
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
          reject(new Error("claude CLI exit " + (code ?? "?") + " - " + stderr.slice(0, 240).trim()));
          return;
        }
        resolve(streaming ? accumulated : stdout);
      });

      child.stdin.write(userPrompt);
      child.stdin.end();
    });
  }

  private writeCodeBlocks(response: string, ventureRoot: string): string[] {
    const written: string[] = [];
    const filenameRegex = /```([\w./-]+\.\w+)\s*\n/g;

    let match;
    while ((match = filenameRegex.exec(response)) !== null) {
      const filename = match[1];
      if (!filename || filename === "json" || filename === "typescript" || filename === "javascript") continue;

      const codeStart = match.index + match[0].length;
      const codeEnd = response.indexOf("\n```", codeStart);
      if (codeEnd === -1) continue;

      const code = response.slice(codeStart, codeEnd);
      const outputPath = path.join(ventureRoot, "07_build", filename);

      try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, code, "utf-8");
        written.push(path.relative(ventureRoot, outputPath));
        log.info(`Wrote: ${outputPath}`);
      } catch (err) {
        log.warn(`Failed to write ${outputPath}: ${err}`);
      }
    }

    return written;
  }

  private emit(percentComplete: number, message: string): void {
    this.onProgress({
      runId: this.bundle.runId,
      status: percentComplete < 100 ? "running" : "success",
      message,
      percentComplete,
      emittedAt: new Date().toISOString(),
    });
  }
}
