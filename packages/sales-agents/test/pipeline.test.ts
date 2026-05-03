/**
 * Pipeline correctness tests.
 *
 * - Dep graph: research first (alone), then BANT/DM/Comp in parallel,
 *   then Outreach last. Verified by recording the order in which
 *   the mock LLM is called per agent.
 * - Race safety: pipeline is sole writer to memory.json; the parallel
 *   fan-out trio cannot clobber each other because the pipeline merges
 *   their slices in a single write between stages.
 * - Partial failure: a single agent failure does NOT abort the
 *   pipeline. Outreach still runs (with whatever upstream slices made
 *   it into memory).
 */
import { describe, expect, it } from "vitest";

import { runSalesPipeline } from "../src/pipeline.js";
import type { CallLlm, SalesMemory } from "../src/types.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";

function makeMockLlm(
  order: string[],
  failAgent?: string,
): CallLlm {
  return async ({ system }) => {
    const id = identifyAgent(system);
    order.push(id);
    if (id === failAgent) throw new Error(`forced failure for ${id}`);
    return cannedResponse(id);
  };
}

function identifyAgent(system: string): string {
  if (system.includes("B2B sales researcher")) return "research";
  if (system.includes("BANT")) return "bant";
  if (system.includes("decision-maker ROLES")) return "decision-makers";
  if (system.includes("competitive intelligence")) return "competitive";
  if (system.includes("outreach sequence")) return "outreach";
  return "unknown";
}

function cannedResponse(agent: string): string {
  switch (agent) {
    case "research":
      return JSON.stringify({ company: { name: "X", industry: "SaaS" } });
    case "bant":
      return JSON.stringify({
        scores: { budget: 4, authority: 3, need: 5, timeline: 4 },
        reasoning: "fine.",
      });
    case "decision-makers":
      return JSON.stringify({ contacts: [{ title: "VP Eng" }] });
    case "competitive":
      return JSON.stringify({ competitors: [{ name: "F", advantage: "X" }] });
    case "outreach":
      return JSON.stringify({ emails: [{ subject: "Hi", body: "Hi." }] });
    default:
      throw new Error(`unmocked agent: ${agent}`);
  }
}

describe("runSalesPipeline", () => {
  it("runs research first, fans out 3 agents, then outreach last", async () => {
    const order: string[] = [];
    const fs = new InMemoryFs();
    await runSalesPipeline({
      prospectUrl: "https://x.com",
      memoryPath: "/m/memory.json",
      fs,
      callLlm: makeMockLlm(order),
    });
    expect(order[0]).toBe("research");
    expect(order[order.length - 1]).toBe("outreach");
    const fanOut = order.slice(1, -1).sort();
    expect(fanOut).toEqual(["bant", "competitive", "decision-makers"]);
  });

  it("populates all 5 slices in memory.json", async () => {
    const fs = new InMemoryFs();
    await runSalesPipeline({
      prospectUrl: "https://x.com",
      memoryPath: "/m/memory.json",
      fs,
      callLlm: makeMockLlm([]),
    });
    const mem = (await fs.readJson<SalesMemory>("/m/memory.json")) ?? {};
    expect(Object.keys(mem).sort()).toEqual([
      "bant",
      "competitiveIntel",
      "decisionMakers",
      "outreach",
      "research",
    ]);
    expect(mem.bant?.fitScore).toBe(80);
    expect(mem.outreach?.emails?.length).toBe(1);
  });

  it("survives partial failure: one agent errors, others still complete", async () => {
    const fs = new InMemoryFs();
    const result = await runSalesPipeline({
      prospectUrl: "https://x.com",
      memoryPath: "/m/memory.json",
      fs,
      callLlm: makeMockLlm([], "decision-makers"),
    });
    const decisionMakers = result.results.find((r) => r.agentName === "DecisionMakerFinderAgent");
    const outreach = result.results.find((r) => r.agentName === "OutreachAgent");
    expect(decisionMakers?.status).toBe("error");
    expect(decisionMakers?.error).toContain("forced failure");
    // Outreach must still run (it happens AFTER fan-out regardless of fan-out failures)
    expect(outreach?.status).toBe("success");
    // BANT + Comp still landed in memory even though DecisionMakers failed
    const mem = (await fs.readJson<SalesMemory>("/m/memory.json")) ?? {};
    expect(mem.bant).toBeDefined();
    expect(mem.competitiveIntel).toBeDefined();
    expect(mem.decisionMakers).toBeUndefined();
  });

  it("memory writes are never racing -- pipeline owns all writes", async () => {
    // The race would manifest as a missing slice when fan-out completes.
    // Run the pipeline 5 times back-to-back and confirm all slices land
    // every time. (If agents wrote directly we would see clobbering.)
    for (let i = 0; i < 5; i++) {
      const fs = new InMemoryFs();
      await runSalesPipeline({
        prospectUrl: "https://x.com",
        memoryPath: "/m/memory.json",
        fs,
        callLlm: makeMockLlm([]),
      });
      const mem = (await fs.readJson<SalesMemory>("/m/memory.json")) ?? {};
      expect(mem.research).toBeDefined();
      expect(mem.bant).toBeDefined();
      expect(mem.decisionMakers).toBeDefined();
      expect(mem.competitiveIntel).toBeDefined();
      expect(mem.outreach).toBeDefined();
    }
  });
});
