/**
 * @founder-os/sales-agents -- shared contracts
 *
 * Pure data + interface declarations. Zero node:* imports so both the
 * client-safe barrel and the Node entry can re-use the same types.
 *
 * Design notes:
 *  - CallLlm is the same shape as the stage-runners SaasLlmCaller. Desktop
 *    consumers wire it via the existing pipeline-llm bridge. Node-side CLI
 *    wires it directly against @anthropic-ai/sdk.
 *  - FsAdapter abstracts disk so the desktop renderer can pass a Tauri-
 *    backed implementation while the CLI passes a node:fs implementation.
 *    Same agent code paths run in both environments.
 *  - SalesMemory is the canonical shared state. Each agent reads what it
 *    needs and writes its own slice. Concurrent writes only happen for the
 *    fan-out trio (BANT / DecisionMakers / CompetitiveIntel) which write
 *    to disjoint keys, so no cross-agent races.
 */

export type CallLlm = (prompt: { system: string; user: string }) => Promise<string>;

export interface FsAdapter {
  readJson<T = unknown>(path: string): Promise<T | null>;
  writeJson(path: string, data: unknown): Promise<void>;
  ensureDir(path: string): Promise<void>;
  pathJoin(...parts: string[]): string;
}

/**
 * Shared mutable state across the five agents. Each agent owns one key.
 * Reading agents must tolerate missing slices so partial runs (one agent
 * fails) still produce useful downstream output where possible.
 */
export interface SalesMemory {
  research?: ResearchSlice;
  bant?: BantSlice;
  decisionMakers?: DecisionMakersSlice;
  competitiveIntel?: CompetitiveIntelSlice;
  outreach?: OutreachSlice;
}

export interface ResearchSlice {
  company: {
    name?: string;
    industry?: string;
    employees?: string | number;
    founded?: string | number;
    location?: string;
    products?: string;
    differentiators?: string;
    recentNews?: string;
    [k: string]: unknown;
  };
  timestamp: string;
}

export interface BantSlice {
  scores: { budget: number; authority: number; need: number; timeline: number };
  fitScore: number;
  reasoning: string;
  timestamp: string;
}

export interface DecisionMakersSlice {
  contacts: Array<{
    title: string;
    department?: string;
    location?: string;
    findingTips?: string;
    [k: string]: unknown;
  }>;
  timestamp: string;
}

export interface CompetitiveIntelSlice {
  competitors: Array<{ name: string; advantage: string }>;
  painPoints?: string[];
  opportunity?: string;
  timestamp: string;
}

export interface OutreachSlice {
  emails: Array<{ subject: string; body: string }>;
  timestamp: string;
}

/**
 * Standard input handed to every agent's run() method. agentMemoryPath is
 * kept on the input rather than the constructor so agents stay stateless --
 * the same instance can be re-used across multiple prospects in a batch.
 */
export interface AgentInput {
  prospectUrl: string;
  memoryPath: string;
  fs: FsAdapter;
  callLlm: CallLlm;
}

export interface AgentOutput {
  agentName: string;
  prospectUrl: string;
  timestamp: string;
  status: "success" | "error";
  data: Record<string, unknown>;
  error?: string;
}

export interface PipelineResult {
  prospectUrl: string;
  memoryPath: string;
  durationMs: number;
  results: AgentOutput[];
}
