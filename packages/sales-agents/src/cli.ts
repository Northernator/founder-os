#!/usr/bin/env tsx
/**
 * sales-agents CLI -- run the pipeline from the terminal.
 *
 * Zero-auth by default: shells out to the Claude Code CLI (`claude -p`)
 * which reuses whatever auth `claude login` already set up. Falls back
 * to ANTHROPIC_API_KEY + @anthropic-ai/sdk if `claude` is not on PATH.
 *
 * Commands:
 *   sales-agents prospect <url> [--venture <path>] [--no-pdf] [--api-key]
 *   sales-agents batch <file>   [--venture <path>] [--no-pdf] [--api-key] [--concurrency 3]
 *   sales-agents report <memory-path> --url <url> [--out <path>]
 *
 * batch input: .json (`{prospects:[...]}` or `[...]`) or .txt (one URL/line, # comments)
 *
 * Output: <venture>/.founder/sales/<slug>/<timestamp>/ OR ./reports/<slug>/<timestamp>/
 */

import { join } from "node:path";

import { slugForUrl } from "./index.js";
import { runBatch } from "./node/batch.js";
import {
  ClaudeCliNotFoundError,
  createClaudeCliCallLlm,
  isClaudeCliAvailable,
} from "./node/claude-cli-caller.js";
import { NodeFsAdapter } from "./node/fs-adapter.js";
import { generateSalesReport } from "./node/pdf-generator.js";
import { runOneProspect } from "./node/run-prospect.js";
import type { CallLlm, SalesMemory } from "./types.js";

const MODEL = process.env.SALES_AGENT_MODEL ?? "claude-sonnet-4-6";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "prospect") return runProspectCmd(rest);
  if (cmd === "batch") return runBatchCmd(rest);
  if (cmd === "report") return runReportCmd(rest);
  printUsage();
  process.exit(cmd ? 1 : 0);
}

async function runProspectCmd(args: string[]): Promise<void> {
  const url = args[0];
  if (!url || url.startsWith("--")) {
    console.error("error: prospect requires a URL argument");
    printUsage();
    process.exit(1);
  }
  const outputRoot = resolveOutputRoot(flag(args, "--venture"));
  const skipPdf = args.includes("--no-pdf");
  const fs = new NodeFsAdapter();
  const { callLlm, label } = await pickCaller(args.includes("--api-key"));

  console.log("\n[sales-agents] running pipeline");
  console.log(`  prospect: ${url}`);
  console.log(`  output:   ${join(outputRoot, slugForUrl(url))}`);
  console.log(`  llm:      ${label}\n`);

  const result = await runOneProspect({
    url,
    outputRoot,
    fs,
    callLlm,
    skipPdf,
    onLog: (level, text) => console.log(`  [${level.padEnd(4)}] ${text}`),
  });

  console.log(`\n[sales-agents] ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  memory: ${result.memoryPath}`);
  if (result.pdfPath) console.log(`  report: ${result.pdfPath}`);
  if (result.error) console.error(`  error:  ${result.error}`);
}

async function runBatchCmd(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath || filePath.startsWith("--")) {
    console.error("error: batch requires a targets file argument");
    printUsage();
    process.exit(1);
  }
  const outputRoot = resolveOutputRoot(flag(args, "--venture"));
  const skipPdf = args.includes("--no-pdf");
  const concurrency = Number(flag(args, "--concurrency") ?? "3") || 3;
  const fs = new NodeFsAdapter();
  const { callLlm, label } = await pickCaller(args.includes("--api-key"));

  console.log("\n[sales-agents] running batch");
  console.log(`  targets:     ${filePath}`);
  console.log(`  output root: ${outputRoot}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log(`  llm:         ${label}\n`);

  const startedAt = new Map<number, number>();
  const result = await runBatch({
    filePath,
    outputRoot,
    fs,
    callLlm,
    concurrency,
    skipPdf,
    onProspectEvent: (e) => {
      if (e.phase === "start") {
        startedAt.set(e.index, Date.now());
        console.log(`  [${e.index + 1}/${e.total}] start  ${e.url}`);
      } else {
        const took = ((Date.now() - (startedAt.get(e.index) ?? Date.now())) / 1000).toFixed(1);
        const tag =
          e.result.status === "success" ? "ok " : e.result.status === "partial" ? "part" : "ERR";
        const extra = e.result.error ? ` -- ${e.result.error.slice(0, 80)}` : "";
        console.log(`  [${e.index + 1}/${e.total}] ${tag}    ${e.result.url} (${took}s)${extra}`);
      }
    },
  });

  console.log(`\n[sales-agents] batch complete in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(
    `  total: ${result.total}  success: ${result.successCount}  partial: ${result.partialCount}  error: ${result.errorCount}`
  );
  if (result.errorCount + result.partialCount > 0) {
    console.log("\n  Issues:");
    for (const r of result.results) {
      if (r.status === "success") continue;
      console.log(`    - ${r.url}: ${r.status}${r.error ? ` -- ${r.error}` : ""}`);
    }
  }
}

async function runReportCmd(args: string[]): Promise<void> {
  const memoryPath = args[0];
  if (!memoryPath || memoryPath.startsWith("--")) {
    console.error("error: report requires a memory.json path");
    printUsage();
    process.exit(1);
  }
  const url = flag(args, "--url");
  if (!url) {
    console.error("error: --url is required for report");
    process.exit(1);
  }
  const outOverride = flag(args, "--out");

  const fs = new NodeFsAdapter();
  const memory = await fs.readJson<SalesMemory>(memoryPath);
  if (!memory) {
    console.error(`error: cannot read ${memoryPath}`);
    process.exit(1);
  }
  const outputPath = outOverride ?? memoryPath.replace(/memory\.json$/, "report.pdf");
  await generateSalesReport({ prospectUrl: url, memory, outputPath });
  console.log(`[sales-agents] report: ${outputPath}`);
}

function resolveOutputRoot(venture: string | undefined): string {
  return venture ? join(venture, ".founder", "sales") : join(process.cwd(), "reports");
}

async function pickCaller(forceApiKey: boolean): Promise<{ callLlm: CallLlm; label: string }> {
  if (!forceApiKey) {
    const ok = await isClaudeCliAvailable();
    if (ok) {
      return {
        callLlm: createClaudeCliCallLlm(),
        label: "claude CLI (zero-auth, via `claude login`)",
      };
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    return {
      callLlm: makeAnthropicCaller(key),
      label: `@anthropic-ai/sdk (model=${MODEL})`,
    };
  }
  console.error(
    "error: no LLM caller available. Either install Claude Code CLI and run\n" +
      `       'claude login', OR set ANTHROPIC_API_KEY in your env.\n` +
      "       Run with --api-key to force the SDK path even if claude is on PATH."
  );
  process.exit(1);
}

function makeAnthropicCaller(key: string): CallLlm {
  return async ({ system, user }) => {
    // SDK types not declared at compile time -- it is an optional peer dep.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // biome-ignore lint/suspicious/noExplicitAny: narrow any used at SDK boundary
    let Anthropic: any;
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch (_err) {
      throw new Error(
        "@anthropic-ai/sdk is not installed.\n" +
          "  Run: pnpm --filter @founder-os/sales-agents add @anthropic-ai/sdk\n" +
          "  Or use the zero-auth path: install Claude Code CLI and run 'claude login'."
      );
    }
    const client = new Anthropic({ apiKey: key });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content[0];
    if (!block || block.type !== "text") {
      throw new Error(`unexpected LLM response shape (type=${block?.type ?? "missing"})`);
    }
    return block.text;
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function printUsage(): void {
  console.log(`
sales-agents -- multi-agent B2B sales pipeline

USAGE
  sales-agents prospect <url>     [--venture path] [--no-pdf] [--api-key]
  sales-agents batch    <file>    [--venture path] [--no-pdf] [--api-key] [--concurrency 3]
  sales-agents report   <mem.json> --url <url> [--out path]

BATCH INPUT
  .json with shape  { "prospects": ["url1", "url2"] }   (recommended)
  .json with shape  ["url1", "url2"]                    (bare array)
  .txt with         one URL per line, # comments and blanks ignored

LLM AUTH (optional, picker tries in order)
  1. Claude Code CLI (preferred, zero-auth) -- requires 'claude' on PATH
     and 'claude login' to have been run once.
  2. ANTHROPIC_API_KEY env var + @anthropic-ai/sdk -- use --api-key to
     force this path even if claude CLI is available.

ENV
  ANTHROPIC_API_KEY    optional, used only as fallback or with --api-key
  SALES_AGENT_MODEL    optional, only affects the api-key path. Default
                       "claude-sonnet-4-6".
`);
}

main().catch((err) => {
  if (err instanceof ClaudeCliNotFoundError) {
    console.error(`\nerror: ${err.message}`);
    console.error("Install Claude Code CLI or set ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
