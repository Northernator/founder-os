/**
 * claude-sub provider tests.
 *
 * Pure unit tests — no subprocess, no fetch. The provider takes an
 * injected CallLlm; we hand it a vi.fn() that returns recorded markdown
 * and assert the resulting ProviderPartial round-trips through the shared
 * parser correctly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeSubInvocationError,
  createClaudeSubProvider,
} from "../src/index.js";
import type { CallLlm, ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "market-size", label: "Market size and growth" },
  questions: [
    {
      id: "q-1",
      question: "What is the UK SaaS market size?",
      angle: "market",
      priority: "must",
    },
    {
      id: "q-2",
      question: "What growth rate is expected over the next three years?",
      angle: "market",
      priority: "should",
    },
  ],
  ventureContext: "An indie SaaS founder targeting small UK accountants.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const goodMarkdown = `## Market size

The UK SaaS market reached around £15bn in 2024 according to industry trackers.

**Sources consulted:**
- TechMarketView UK SaaS report 2024, TechMarketView, accessed 2026-05-18 — https://www.techmarketview.com/uk-saas-2024
- Companies House SaaS analysis, gov.uk, accessed 2026-05-18 — https://www.gov.uk/government/statistics/saas-2024

## Growth outlook

Analysts project 12-14% CAGR through 2027.

**Sources consulted:**
- Gartner UK SaaS forecast, Gartner, accessed 2026-05-18 — https://www.gartner.com/uk-saas-forecast
`;

describe("createClaudeSubProvider", () => {
  it("reports name=claude-sub by default", () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({ callLlm });
    expect(p.name).toBe("claude-sub");
  });

  it("honours channelOverride for API-fallback reuse", () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({ callLlm, channelOverride: "claude-api" });
    expect(p.name).toBe("claude-api");
  });

  it("available() proxies the injected probe", async () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const probeYes = createClaudeSubProvider({
      callLlm,
      isAvailable: async () => true,
    });
    const probeNo = createClaudeSubProvider({
      callLlm,
      isAvailable: async () => false,
    });
    expect(await probeYes.available()).toBe(true);
    expect(await probeNo.available()).toBe(false);
  });

  it("available() swallows probe exceptions and returns false", async () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({
      callLlm,
      isAvailable: async () => {
        throw new Error("boom");
      },
    });
    expect(await p.available()).toBe(false);
  });

  it("researchTopic returns parsed sections + sources from the LLM markdown", async () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({ callLlm });
    const partial = await p.researchTopic(sampleTopic);

    expect(partial.sections).toHaveLength(2);
    expect(partial.sections[0]?.heading).toBe("Market size");
    expect(partial.sections[1]?.heading).toBe("Growth outlook");
    // Three distinct URLs across the two sections.
    expect(partial.sources).toHaveLength(3);
    expect(partial.sources.every((s) => s.retrievedBy === "claude-sub")).toBe(true);
    expect(partial.sources.every((s) => s.accessedAt === sampleTopic.accessedAt)).toBe(true);
  });

  it("researchTopic threads system + user prompt to the callLlm", async () => {
    const callLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({ callLlm });
    await p.researchTopic(sampleTopic);
    expect(callLlm).toHaveBeenCalledTimes(1);
    const call = callLlm.mock.calls[0]?.[0];
    expect(call?.system).toContain("deep research analyst");
    expect(call?.user).toContain("Market size and growth");
    expect(call?.user).toContain("indie SaaS founder");
  });

  it("throws ClaudeSubInvocationError when callLlm rejects", async () => {
    const callLlm: CallLlm = vi.fn(async () => {
      throw new Error("network down");
    });
    const p = createClaudeSubProvider({ callLlm });
    await expect(p.researchTopic(sampleTopic)).rejects.toBeInstanceOf(
      ClaudeSubInvocationError,
    );
  });

  it("throws ClaudeSubInvocationError when callLlm returns empty", async () => {
    const callLlm: CallLlm = vi.fn(async () => "   ");
    const p = createClaudeSubProvider({ callLlm });
    await expect(p.researchTopic(sampleTopic)).rejects.toBeInstanceOf(
      ClaudeSubInvocationError,
    );
  });

  it("rawTranscript captures the system / user / response triple", async () => {
    const callLlm: CallLlm = vi.fn(async () => goodMarkdown);
    const p = createClaudeSubProvider({ callLlm });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.rawTranscript).toMatchObject({
      channel: "claude-sub",
      response: goodMarkdown,
    });
  });
});
