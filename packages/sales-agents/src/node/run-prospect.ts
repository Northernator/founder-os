/**
 * runOneProspect -- shared helper for single + batch CLI modes.
 *
 * Encapsulates the per-prospect pipeline: ensure output dir, run the
 * five-agent pipeline against memory.json, optionally render the PDF
 * via pdfkit. Returns the artifact paths + duration so callers can
 * print summary tables or stream progress.
 *
 * Pure logic with injected fs + callLlm + onLog -- the same helper is
 * used by `sales-agents prospect` (single) and `sales-agents batch`
 * (parallel-with-cap), and would be reusable from a future scheduled
 * task or sidecar.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { runSalesPipeline, slugForUrl } from "../index.js";
import type { CallLlm, FsAdapter, PipelineResult, SalesMemory } from "../types.js";
import { generateSalesReport } from "./pdf-generator.js";

export interface RunOneProspectOpts {
  url: string;
  /** Parent dir under which a <slug>/<timestamp>/ subdir is created. */
  outputRoot: string;
  fs: FsAdapter;
  callLlm: CallLlm;
  /** Skip PDF generation -- useful for batch dry runs or when only memory.json is wanted. */
  skipPdf?: boolean;
  /** Optional log sink -- batch passes a prefixed logger so streams stay readable. */
  onLog?: (level: "info" | "ok" | "err", text: string) => void;
}

export interface RunOneProspectResult {
  url: string;
  slug: string;
  baseDir: string;
  memoryPath: string;
  pdfPath: string | null;
  durationMs: number;
  status: "success" | "partial" | "error";
  /** Per-agent status for the summary table. */
  agentSummary: { agent: string; ok: boolean }[];
  error?: string;
}

export async function runOneProspect(opts: RunOneProspectOpts): Promise<RunOneProspectResult> {
  const { url, outputRoot, fs, callLlm, skipPdf, onLog } = opts;
  const log = onLog ?? (() => {});
  const slug = slugForUrl(url);
  const stamp = stampNow();
  const baseDir = join(outputRoot, slug, stamp);
  const memoryPath = join(baseDir, "memory.json");
  await mkdir(baseDir, { recursive: true });

  let pipeline: PipelineResult;
  try {
    pipeline = await runSalesPipeline({
      prospectUrl: url,
      memoryPath,
      fs,
      callLlm,
      onProgress: (e) => {
        if (e.phase === "start") log("info", `start: ${e.agent}`);
        else log(e.output?.status === "success" ? "ok" : "err", `${e.output?.status}: ${e.agent}`);
      },
    });
  } catch (err) {
    return {
      url,
      slug,
      baseDir,
      memoryPath,
      pdfPath: null,
      durationMs: 0,
      status: "error",
      agentSummary: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const agentSummary = pipeline.results.map((r) => ({
    agent: r.agentName,
    ok: r.status === "success",
  }));
  const allOk = agentSummary.every((a) => a.ok);
  const status: "success" | "partial" = allOk ? "success" : "partial";

  let pdfPath: string | null = null;
  if (!skipPdf) {
    try {
      const memory = (await fs.readJson<SalesMemory>(memoryPath)) ?? {};
      pdfPath = join(baseDir, "report.pdf");
      await generateSalesReport({ prospectUrl: url, memory, outputPath: pdfPath });
      log("ok", `PDF written: ${pdfPath}`);
    } catch (err) {
      log("err", `PDF gen failed: ${err instanceof Error ? err.message : String(err)}`);
      pdfPath = null;
    }
  }

  return {
    url,
    slug,
    baseDir,
    memoryPath,
    pdfPath,
    durationMs: pipeline.durationMs,
    status,
    agentSummary,
  };
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
