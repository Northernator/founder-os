/**
 * BaseAgent -- shared scaffolding for the five sales agents.
 *
 * Design contract:
 *  - Agents are PURE COMPUTE. They read SalesMemory (to consume prior
 *    agents' output), call the LLM, and return their data slice in
 *    AgentOutput.data. They never write memory themselves.
 *  - The SalesPipeline owns all memory writes. This eliminates the
 *    read/mutate/write race that would otherwise clobber slices when
 *    BANT, DecisionMakers, and CompetitiveIntel run in parallel.
 *  - Agents are runtime-agnostic: the LLM transport is injected via
 *    CallLlm. Desktop renderer wires the existing pipeline-llm bridge;
 *    CLI wraps @anthropic-ai/sdk. Pushing the SDK out keeps this barrel
 *    bundlable for the Tauri WebView.
 */

import type { AgentInput, AgentOutput, CallLlm, FsAdapter, SalesMemory } from "./types.js";

export abstract class BaseAgent {
  abstract readonly name: string;

  /** Read the current shared memory. Returns {} if the file does not exist. */
  protected async loadMemory(fs: FsAdapter, path: string): Promise<SalesMemory> {
    const data = await fs.readJson<SalesMemory>(path);
    return data ?? {};
  }

  /**
   * Call the LLM and parse the response as JSON. Strips a single wrapping
   * ```json ... ``` fence if present (Claude often emits these despite
   * being asked for raw JSON). Throws if the result still does not parse;
   * the wrapper in run() turns that into an AgentOutput error.
   */
  protected async callJson<T = Record<string, unknown>>(
    callLlm: CallLlm,
    system: string,
    user: string
  ): Promise<T> {
    const raw = await callLlm({ system, user });
    const trimmed = stripCodeFence(raw).trim();
    return JSON.parse(trimmed) as T;
  }

  /** Standard run wrapper -- subclasses implement execute() and return their slice. */
  async run(input: AgentInput): Promise<AgentOutput> {
    const ts = new Date().toISOString();
    try {
      const data = await this.execute(input);
      return {
        agentName: this.name,
        prospectUrl: input.prospectUrl,
        timestamp: ts,
        status: "success",
        data,
      };
    } catch (err) {
      return {
        agentName: this.name,
        prospectUrl: input.prospectUrl,
        timestamp: ts,
        status: "error",
        data: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected abstract execute(input: AgentInput): Promise<Record<string, unknown>>;
}

function stripCodeFence(raw: string): string {
  const fenceMatch = raw.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fenceMatch?.[1] ?? raw;
}
