/**
 * @founder-os/sales-agents public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that needs the Node
 * runtime (file-backed fs adapter, PDF generation via pdfkit, the CLI)
 * lives in the "./node" or "./cli" subpaths:
 *
 *   import { NodeFsAdapter, generateSalesReport } from
 *     "@founder-os/sales-agents/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors the @founder-os/prompt-master split.
 *
 * Typical desktop / browser usage:
 *
 *   import { runSalesPipeline } from "@founder-os/sales-agents";
 *
 *   const result = await runSalesPipeline({
 *     prospectUrl: "https://acme.com",
 *     memoryPath: "<venture>/.founder/sales/acme/run-1/memory.json",
 *     fs: tauriFsAdapter,
 *     callLlm: pipelineLlmCaller,
 *   });
 */

export type {
  AgentInput,
  AgentOutput,
  BantSlice,
  CallLlm,
  CompetitiveIntelSlice,
  DecisionMakersSlice,
  FsAdapter,
  OutreachSlice,
  PipelineResult,
  ResearchSlice,
  SalesMemory,
} from "./types.js";

export { BaseAgent } from "./agent-base.js";
export { ResearchAgent } from "./agents/research.js";
export { BantAgent } from "./agents/bant.js";
export { DecisionMakerFinderAgent } from "./agents/decision-makers.js";
export { CompetitiveIntelAgent } from "./agents/competitive-intel.js";
export { OutreachAgent } from "./agents/outreach.js";

export { runSalesPipeline, slugForUrl } from "./pipeline.js";
