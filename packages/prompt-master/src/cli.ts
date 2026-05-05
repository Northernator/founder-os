#!/usr/bin/env node
/**
 * prompt-master CLI.
 *
 * Two commands for v1:
 *
 *   prompt-master stats [--since=24h]
 *     Read the telemetry log and report cumulative tokens saved, cache hit
 *     rate, and per-context breakdown over the given window.
 *
 *   prompt-master optimize-static <glob>
 *     Walk matched .ts files, find string-literal exports + tagged-template
 *     exports, run each through the optimizer, and write a sibling .opt.ts
 *     file containing the optimized values. Source files stay readable; the
 *     barrel index can choose which set to ship via env flag.
 *
 * Tier-1 limits: this is a v1 implementation. We use a simple regex pass for
 * `export const NAME = "..."` and `export const NAME = `...``. AST-based
 * extraction with ts-morph would handle every shape but is overkill until
 * we hit a real-world template the regex misses. Document and iterate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { inspectCache } from "./cache.js";
import { optimize } from "./core.js";
import { installNodeBackends } from "./node.js";
import { getLogFile } from "./telemetry-fs.js";

// CLI is Node-only. Install the disk-backed cache + ndjson telemetry sink so
// stats commands and cache lookups read/write the same files the runtime app
// uses. Idempotent.
installNodeBackends();

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "stats":
      await stats(parseSinceArg(args));
      break;
    case "optimize-static":
      if (args.length === 0) {
        console.error("Usage: prompt-master optimize-static <glob>");
        process.exit(1);
      }
      // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
      await optimizeStatic(args[0]!);
      break;
    case "version":
      console.log("@founder-os/prompt-master 0.1.0");
      break;
    default:
      console.log("Usage: prompt-master <stats|optimize-static|version>");
      process.exit(cmd ? 1 : 0);
  }
}

function parseSinceArg(args: string[]): number {
  const sinceArg = args.find((a) => a.startsWith("--since="));
  if (!sinceArg) return 24 * 60 * 60 * 1000; // 24h default
  const v = sinceArg.slice("--since=".length);
  const m = v.match(/^(\d+)([hdm])$/);
  if (!m) return 24 * 60 * 60 * 1000;
  // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
  const n = Number.parseInt(m[1]!, 10);
  // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
  const unit = m[2]!;
  return n * (unit === "h" ? 3600_000 : unit === "d" ? 86_400_000 : 60_000);
}

async function stats(windowMs: number): Promise<void> {
  const cutoff = Date.now() - windowMs;
  let raw: string;
  try {
    raw = await readFile(getLogFile(), "utf8");
  } catch {
    console.log("No telemetry log yet at", getLogFile());
    return;
  }

  let totalSaved = 0;
  let calls = 0;
  let hits = 0;
  let fallbacks = 0;
  const byContext = new Map<string, { saved: number; calls: number }>();

  for (const line of raw.split("\n").filter(Boolean)) {
    let evt: {
      event: string;
      ts: string;
      context?: string;
      tokensSaved?: number;
      cacheHit?: boolean;
    };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (Date.parse(evt.ts) < cutoff) continue;

    if (evt.event === "prompt_master.optimize") {
      calls++;
      if (evt.cacheHit) hits++;
      totalSaved += evt.tokensSaved ?? 0;
      const ctx = evt.context ?? "other";
      const cur = byContext.get(ctx) ?? { saved: 0, calls: 0 };
      cur.saved += evt.tokensSaved ?? 0;
      cur.calls++;
      byContext.set(ctx, cur);
    } else if (evt.event === "prompt_master.fallback") {
      fallbacks++;
    }
  }

  const cache = await inspectCache();
  const hitRate = calls > 0 ? ((hits / calls) * 100).toFixed(1) : "0.0";

  console.log(`prompt-master stats (window: ${(windowMs / 3600_000).toFixed(1)}h)`);
  console.log(`  calls:     ${calls}`);
  console.log(`  cache hits: ${hits} (${hitRate}%)`);
  console.log(`  fallbacks: ${fallbacks}`);
  console.log(`  tokens saved: ${totalSaved}`);
  console.log(
    `  cache:     ${cache.entries} entries / ${(cache.totalBytes / 1024 / 1024).toFixed(2)} MB / cap ${(cache.capBytes / 1024 / 1024).toFixed(0)} MB`
  );
  console.log("  by context:");
  for (const [ctx, s] of byContext) {
    console.log(`    ${ctx}: ${s.saved} saved over ${s.calls} calls`);
  }
}

async function optimizeStatic(pattern: string): Promise<void> {
  // Node 22+ has fs.glob async iterator; treat any error as "no matches".
  const matches: string[] = [];
  try {
    for await (const file of glob(pattern)) {
      if (typeof file === "string") matches.push(file);
    }
  } catch (err) {
    console.error("glob failed:", (err as Error).message);
    process.exit(1);
  }

  for (const file of matches) {
    if (file.endsWith(".opt.ts")) continue; // Don't re-optimize our own output.
    const source = await readFile(file, "utf8");
    const exportRe = /export\s+const\s+(\w+)\s*=\s*(`[^`]+`|"(?:\\"|[^"])*")\s*;/g;
    const optLines: string[] = [
      "// AUTO-GENERATED by prompt-master optimize-static. Do not edit by hand.",
      `// Source: ${file.split(/[\\/]/).pop()}`,
      "",
    ];
    let anyOptimized = false;
    for (const m of source.matchAll(exportRe)) {
      // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
      const name = m[1]!;
      // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
      const literal = m[2]!;
      const original = literal.startsWith("`") ? literal.slice(1, -1) : JSON.parse(literal);
      const { optimized, tokensSaved, fallbackUsed } = await optimize({
        prompt: original,
        context: "system",
      });
      anyOptimized ||= !fallbackUsed;
      optLines.push(
        `// ${name}: tokens saved ~${tokensSaved}${fallbackUsed ? " (fallback - no transport)" : ""}`
      );
      optLines.push(`export const ${name}_OPTIMIZED = ${JSON.stringify(optimized)};`);
      optLines.push("");
    }
    if (!anyOptimized && matches.length > 0) {
      console.log(`[skip] ${file}: no transport configured, all results are pass-through`);
    }
    const outPath = file.replace(/\.ts$/, ".opt.ts");
    await writeFile(outPath, optLines.join("\n"), "utf8");
    console.log(`[wrote] ${outPath}`);
  }
}

main().catch((err) => {
  console.error("[prompt-master] fatal:", err);
  process.exit(1);
});
