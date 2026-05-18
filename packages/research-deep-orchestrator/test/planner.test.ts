/**
 * Planner tests.
 *
 * Pure unit tests — the planner takes an injected CallLlm chain. Tests
 * hand in vi.fn() fakes and assert the parser + fallback chain behaves.
 */
import { describe, expect, it, vi } from "vitest";
import { PlannerError, planTopic } from "../src/index.js";
import type { CallLlm } from "@founder-os/research-deep-core";

const sampleTopic = {
  topic: { slug: "market-size", label: "UK SaaS market size" },
  ventureContext: "Solo founder targeting UK accountants.",
};

const validPlanJson = JSON.stringify({
  questions: [
    {
      id: "q-market-size",
      question: "What is the UK SaaS market size in 2026?",
      angle: "market",
      priority: "must",
    },
    {
      id: "q-growth-rate",
      question: "What CAGR is forecast through 2028?",
      angle: "market",
      priority: "should",
    },
    {
      id: "q-top-segments",
      question: "Which UK SaaS verticals are growing fastest?",
      angle: "market",
      priority: "should",
    },
  ],
});

describe("planTopic", () => {
  it("returns validated questions when primary caller succeeds", async () => {
    const primary: CallLlm = vi.fn(async () => validPlanJson);
    const result = await planTopic(sampleTopic, { callLlmChain: [primary] });
    expect(result.questions).toHaveLength(3);
    expect(result.questions[0]?.id).toBe("q-market-size");
    expect(result.fallbackIndex).toBe(0);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next caller when the primary rejects", async () => {
    const primary: CallLlm = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const fallback: CallLlm = vi.fn(async () => validPlanJson);
    const result = await planTopic(sampleTopic, {
      callLlmChain: [primary, fallback],
    });
    expect(result.fallbackIndex).toBe(1);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("falls through on malformed JSON output too", async () => {
    const primary: CallLlm = vi.fn(async () => "not json at all");
    const fallback: CallLlm = vi.fn(async () => validPlanJson);
    const result = await planTopic(sampleTopic, {
      callLlmChain: [primary, fallback],
    });
    expect(result.fallbackIndex).toBe(1);
  });

  it("strips ```json fences from the LLM response before parsing", async () => {
    const fenced: CallLlm = vi.fn(async () => `\`\`\`json\n${validPlanJson}\n\`\`\``);
    const result = await planTopic(sampleTopic, { callLlmChain: [fenced] });
    expect(result.questions).toHaveLength(3);
  });

  it("throws PlannerError when every caller fails", async () => {
    const failing: CallLlm = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      planTopic(sampleTopic, { callLlmChain: [failing, failing] }),
    ).rejects.toBeInstanceOf(PlannerError);
  });

  it("threads seed questions into the prompt", async () => {
    const captured: { user: string }[] = [];
    const caller: CallLlm = vi.fn(async (p) => {
      captured.push({ user: p.user });
      return validPlanJson;
    });
    await planTopic(
      {
        ...sampleTopic,
        seedQuestions: [
          {
            id: "seed-1",
            question: "What does the founder's intake say about ICP?",
            angle: "customer",
            priority: "must",
          },
        ],
      },
      { callLlmChain: [caller] },
    );
    expect(captured[0]?.user).toContain("Seed questions");
    expect(captured[0]?.user).toContain("ICP");
  });

  it("de-duplicates question ids — last one wins", async () => {
    const duplicateIdJson = JSON.stringify({
      questions: [
        {
          id: "q-x",
          question: "first",
          angle: "market",
          priority: "should",
        },
        {
          id: "q-x",
          question: "second (refinement)",
          angle: "market",
          priority: "must",
        },
      ],
    });
    const caller: CallLlm = vi.fn(async () => duplicateIdJson);
    const result = await planTopic(sampleTopic, { callLlmChain: [caller] });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.question).toBe("second (refinement)");
    expect(result.questions[0]?.priority).toBe("must");
  });
});
