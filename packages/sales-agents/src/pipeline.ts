/**
 * SalesPipeline -- orchestrates the five agents in the correct dependency
 * order. The original spec ran all five in parallel which would have
 * failed: BANT / DecisionMakers / CompetitiveIntel all consume the
 * research slice, and Outreach consumes all four upstream slices.
 *
 * Real dependency graph:
 *
 *     Research               (stage 1, alone)
 *        |
 *        +--> BANT ----------+
 *        +--> DecisionMakers +    (stage 2, parallel fan-out)
 *        +--> CompetitiveInt +
 *                              \
 *                               +--> Outreach   (stage 3, alone)
 *
 * The pipeline is the SOLE WRITER of memory.json. Agents return their
 * slice; the pipeline merges and persists between stages. This sidesteps
 * the read/mutate/write race that would otherwise clobber slices when
 * the stage-2 fan-out completes.
 *
 * Exposes onProgress for callers (desktop tab, CLI) that want to stream
 * per-agent status as it lands.
 */

import { BantAgent } from "./agents/bant.js";
import { CompetitiveIntelAgent } from "./agents/competitive-intel.js";
import { DecisionMakerFinderAgent } from "./agents/decision-makers.js";
import { OutreachAgent } from "./agents/outreach.js";
import { ResearchAgent } from "./agents/research.js";
import type {
  AgentInput,
  AgentOutput,
  CallLlm,
  FsAdapter,
  PipelineResult,
  SalesMemory,
} from "./types.js";

export interface RunSalesPipelineOpts {
  prospectUrl: string;
  /** Absolute path to memory.json -- caller decides where it lives. */
  memoryPath: string;
  fs: FsAdapter;
  callLlm: CallLlm;
  /** Streamed per-agent status -- useful for live UI. */
  onProgress?: (event: { phase: "start" | "result"; agent: string; output?: AgentOutput }) => void;
}

export async function runSalesPipeline(opts: RunSalesPipelineOpts): Promise<PipelineResult> {
  const { prospectUrl, memoryPath, fs, callLlm, onProgress } = opts;
  const start = Date.now();

  // Ensure parent directory exists, seed an empty memory file so agents
  // doing read-then-merge see a well-formed shape from the first call.
  const dir = parentDir(memoryPath);
  await fs.ensureDir(dir);
  const existing = (await fs.readJson<SalesMemory>(memoryPath)) ?? {};
  await fs.writeJson(memoryPath, existing);

  const input: AgentInput = { prospectUrl, memoryPath, fs, callLlm };
  const results: AgentOutput[] = [];

  // ---- Stage 1: Research alone ----
  const research = new ResearchAgent();
  onProgress?.({ phase: "start", agent: research.name });
  const researchOut = await research.run(input);
  results.push(researchOut);
  if (researchOut.status === "success") {
    await mergeAndSave(fs, memoryPath, {
      research: researchOut.data as unknown as SalesMemory["research"],
    });
  }
  onProgress?.({ phase: "result", agent: research.name, output: researchOut });

  // ---- Stage 2: fan-out (BANT, DecisionMakers, CompetitiveIntel in parallel) ----
  const fanOut = [new BantAgent(), new DecisionMakerFinderAgent(), new CompetitiveIntelAgent()];
  for (const agent of fanOut) onProgress?.({ phase: "start", agent: agent.name });
  const fanOutResults = await Promise.all(fanOut.map((a) => a.run(input)));
  results.push(...fanOutResults);

  // Merge ALL fan-out slices in a single write so we never overlap with
  // each other (each agent owns a disjoint key).
  const fanOutPatch: Partial<SalesMemory> = {};
  for (const out of fanOutResults) {
    if (out.status !== "success") continue;
    if (out.agentName === "BantAgent")
      fanOutPatch.bant = out.data as unknown as SalesMemory["bant"];
    if (out.agentName === "DecisionMakerFinderAgent")
      fanOutPatch.decisionMakers = out.data as unknown as SalesMemory["decisionMakers"];
    if (out.agentName === "CompetitiveIntelAgent")
      fanOutPatch.competitiveIntel = out.data as unknown as SalesMemory["competitiveIntel"];
  }
  await mergeAndSave(fs, memoryPath, fanOutPatch);
  for (const out of fanOutResults) {
    onProgress?.({ phase: "result", agent: out.agentName, output: out });
  }

  // ---- Stage 3: Outreach (consumes everything) ----
  const outreach = new OutreachAgent();
  onProgress?.({ phase: "start", agent: outreach.name });
  const outreachOut = await outreach.run(input);
  results.push(outreachOut);
  if (outreachOut.status === "success") {
    await mergeAndSave(fs, memoryPath, {
      outreach: outreachOut.data as unknown as SalesMemory["outreach"],
    });
  }
  onProgress?.({ phase: "result", agent: outreach.name, output: outreachOut });

  return {
    prospectUrl,
    memoryPath,
    durationMs: Date.now() - start,
    results,
  };
}

async function mergeAndSave(
  fs: FsAdapter,
  path: string,
  patch: Partial<SalesMemory>
): Promise<void> {
  const current = (await fs.readJson<SalesMemory>(path)) ?? {};
  await fs.writeJson(path, { ...current, ...patch });
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "." : norm.slice(0, idx);
}

/**
 * Turn a URL into a filesystem-safe slug used for output directories.
 * "https://www.acme.com/products" -> "acme-com"
 */
export function slugForUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
  } catch {
    return url
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 64);
  }
}
