/**
 * runBatch -- run the sales pipeline against N prospects with a
 * concurrency cap.
 *
 * Input formats accepted:
 *   - JSON: { "prospects": ["url1", "url2"] }     (recommended -- matches spec)
 *   - JSON: ["url1", "url2"]                       (bare array shorthand)
 *   - TXT:  one URL per line, # comments + blanks ignored
 *
 * Concurrency note: the pipeline itself fans out 3 agents in parallel
 * per prospect. The concurrency limit here applies at the PROSPECT
 * level. So `--concurrency 3` runs up to 3 prospects in flight, each
 * potentially running up to 3 agents in parallel = up to 9 concurrent
 * LLM calls. Default 3 keeps things gentle on rate limits.
 *
 * Failure handling: a single prospect failing does not abort the batch.
 * The summary captures per-prospect status; caller decides what to do.
 */

import { readFile } from "node:fs/promises";

import type { CallLlm, FsAdapter } from "../types.js";
import { type RunOneProspectResult, runOneProspect } from "./run-prospect.js";

export interface RunBatchOpts {
  /** Path to targets file (.json or .txt). */
  filePath: string;
  /** Parent dir for all outputs. Each prospect gets <slug>/<ts>/ underneath. */
  outputRoot: string;
  fs: FsAdapter;
  callLlm: CallLlm;
  /** Default 3. Higher = faster but more API pressure. */
  concurrency?: number;
  skipPdf?: boolean;
  /**
   * Per-prospect lifecycle callback. Fires when each prospect starts
   * AND when it finishes (so callers can stream `[i/N] ...` progress).
   */
  onProspectEvent?: (event: ProspectEvent) => void;
}

export type ProspectEvent =
  | { phase: "start"; index: number; total: number; url: string }
  | { phase: "done"; index: number; total: number; result: RunOneProspectResult };

export interface RunBatchResult {
  total: number;
  durationMs: number;
  results: RunOneProspectResult[];
  successCount: number;
  partialCount: number;
  errorCount: number;
}

export async function runBatch(opts: RunBatchOpts): Promise<RunBatchResult> {
  const start = Date.now();
  const urls = await loadTargets(opts.filePath);
  if (urls.length === 0) throw new Error(`no prospect URLs found in ${opts.filePath}`);

  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const total = urls.length;
  const results: RunOneProspectResult[] = new Array(total);
  let next = 0;
  let inFlight = 0;
  let resolveAll: (() => void) | null = null;
  const allDone = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  function tryDispatch(): void {
    while (inFlight < concurrency && next < total) {
      const idx = next++;
      const url = urls[idx];
      if (!url) {
        // Should not happen given urls.length check, but satisfies noUncheckedIndexedAccess.
        results[idx] = makeMissingUrlResult(idx);
        if (next >= total && inFlight === 0) resolveAll?.();
        continue;
      }
      inFlight++;
      opts.onProspectEvent?.({ phase: "start", index: idx, total, url });
      runOneProspect({
        url,
        outputRoot: opts.outputRoot,
        fs: opts.fs,
        callLlm: opts.callLlm,
        skipPdf: opts.skipPdf,
      })
        .then((result) => {
          results[idx] = result;
          opts.onProspectEvent?.({ phase: "done", index: idx, total, result });
        })
        .catch((err) => {
          results[idx] = {
            url,
            slug: url,
            baseDir: "",
            memoryPath: "",
            pdfPath: null,
            durationMs: 0,
            status: "error",
            agentSummary: [],
            error: err instanceof Error ? err.message : String(err),
          };
          // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
          opts.onProspectEvent?.({ phase: "done", index: idx, total, result: results[idx]! });
        })
        .finally(() => {
          inFlight--;
          if (next < total) tryDispatch();
          else if (inFlight === 0) resolveAll?.();
        });
    }
  }

  tryDispatch();
  await allDone;

  let successCount = 0;
  let partialCount = 0;
  let errorCount = 0;
  for (const r of results) {
    if (r.status === "success") successCount++;
    else if (r.status === "partial") partialCount++;
    else errorCount++;
  }

  return {
    total,
    durationMs: Date.now() - start,
    results,
    successCount,
    partialCount,
    errorCount,
  };
}

/** Parse targets file into a list of URL strings. Supports JSON + .txt. */
async function loadTargets(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf-8");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonTargets(trimmed, path);
  }
  // Plain text: one URL per line, # comments and blanks ignored.
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function parseJsonTargets(raw: string, path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`could not parse JSON in ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (Array.isArray(parsed)) return parsed.filter(isUrlString);
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { prospects?: unknown }).prospects)
  ) {
    return (parsed as { prospects: unknown[] }).prospects.filter(isUrlString);
  }
  throw new Error(`${path} JSON must be an array of URLs or an object with a "prospects" array`);
}

function isUrlString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function makeMissingUrlResult(idx: number): RunOneProspectResult {
  return {
    url: `<missing-${idx}>`,
    slug: `missing-${idx}`,
    baseDir: "",
    memoryPath: "",
    pdfPath: null,
    durationMs: 0,
    status: "error",
    agentSummary: [],
    error: "url was empty/undefined",
  };
}
