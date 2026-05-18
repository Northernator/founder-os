/**
 * End-to-end orchestrator tests.
 *
 * Drives orchestrateTopic with all three phases (planner CallLlm, worker
 * providers, cross-ref CallLlm, synthesiser CallLlm) mocked in-memory.
 * Covers:
 *   - happy path: 3 workers + cross-ref + synth
 *   - single-channel deterministic fallback
 *   - all-workers-fail → AllWorkersFailedError
 *   - cross-ref failure degrades gracefully (synthesiser still runs)
 *   - progress events fire in order
 */
import { describe, expect, it, vi } from "vitest";
import {
  AllWorkersFailedError,
  orchestrateTopic,
  type OrchestrateProgress,
} from "../src/index.js";
import type {
  CallLlm,
  ProviderPartial,
  ResearchChannel,
  ResearchProvider,
} from "@founder-os/research-deep-core";

function fakePartial(channel: ResearchChannel, url: string): ProviderPartial {
  return {
    sections: [
      {
        heading: "Market size",
        body: `${channel} findings`,
        sources: [url],
      },
    ],
    sources: [
      {
        url,
        title: `${channel} source`,
        accessedAt: "2026-05-18T09:00:00.000Z",
        retrievedBy: channel,
        trustTier: "secondary",
      },
    ],
    unanswered: [],
    rawTranscript: { channel },
  };
}

function fakeProvider(
  channel: ResearchChannel,
  url: string,
  opts: { available?: boolean; rejects?: boolean } = {},
): ResearchProvider {
  return {
    name: channel,
    available: vi.fn(async () => opts.available ?? true),
    researchTopic: vi.fn(async () => {
      if (opts.rejects) throw new Error(`${channel} researchTopic rejected`);
      return fakePartial(channel, url);
    }),
  };
}

const plannerJson = JSON.stringify({
  questions: [
    {
      id: "q-market-size",
      question: "What is the UK SaaS market size in 2026?",
      angle: "market",
      priority: "must",
    },
  ],
});

const crossRefJson = JSON.stringify({
  verdicts: [
    { heading: "Market size", channel: "claude-sub", agreed: true },
    { heading: "Market size", channel: "gemini-sub", agreed: true },
  ],
  disagreements: [],
});

const synthJson = JSON.stringify({
  sections: [
    {
      heading: "Market size",
      body: "Synthesised prose.",
      sources: ["https://a.example.com", "https://b.example.com"],
    },
  ],
  unanswered: [],
});

const baseOpts = {
  ventureSlug: "acme",
  topic: { slug: "market-size", label: "UK SaaS market size" },
  ventureContext: "Solo founder.",
  generatedAt: "2026-05-18T10:00:00.000Z",
  accessedAt: "2026-05-18T09:00:00.000Z",
} as const;

describe("orchestrateTopic — happy path", () => {
  it("runs plan → workers → cross-ref → synth and returns a valid briefing", async () => {
    const planner: CallLlm = vi.fn(async () => plannerJson);
    const crossRef: CallLlm = vi.fn(async () => crossRefJson);
    const synth: CallLlm = vi.fn(async () => synthJson);
    const events: OrchestrateProgress[] = [];

    const result = await orchestrateTopic({
      ...baseOpts,
      plannerCallLlmChain: [planner],
      workers: [
        fakeProvider("claude-sub", "https://a.example.com"),
        fakeProvider("gemini-sub", "https://b.example.com"),
      ],
      crossReferenceCallLlm: crossRef,
      synthesiserCallLlm: synth,
      onProgress: (e) => events.push(e),
    });

    expect(result.briefing.sections).toHaveLength(1);
    expect(result.briefing.channelsUsed).toEqual(["claude-sub", "gemini-sub"]);
    expect(result.briefing.crossReferencedBy).toEqual(["claude-sub"]);
    expect(result.briefing.synthesisedBy).toBe("claude-sub");
    expect(result.briefing.sources).toHaveLength(2);
    expect(result.questions).toHaveLength(1);

    const phases = events.map((e) => e.phase);
    expect(phases).toEqual([
      "planner-start",
      "planner-done",
      "workers-start",
      "workers-done",
      "cross-reference-start",
      "cross-reference-done",
      "synthesiser-start",
      "synthesiser-done",
    ]);
  });
});

describe("orchestrateTopic — single-channel deterministic fallback", () => {
  it("skips cross-ref + LLM-synth when only one worker succeeds", async () => {
    const planner: CallLlm = vi.fn(async () => plannerJson);
    const crossRef: CallLlm = vi.fn();
    const synth: CallLlm = vi.fn();
    const events: OrchestrateProgress[] = [];

    const result = await orchestrateTopic({
      ...baseOpts,
      plannerCallLlmChain: [planner],
      workers: [
        fakeProvider("claude-sub", "https://a.example.com"),
        fakeProvider("gemini-sub", "https://b.example.com", { rejects: true }),
      ],
      crossReferenceCallLlm: crossRef,
      synthesiserCallLlm: synth,
      onProgress: (e) => events.push(e),
    });

    expect(crossRef).not.toHaveBeenCalled();
    expect(synth).not.toHaveBeenCalled();
    expect(result.briefing.channelsUsed).toEqual(["claude-sub"]);
    expect(result.briefing.crossReferencedBy).toEqual([]);
    expect(result.briefing.synthesisedBy).toBeUndefined();
    expect(result.briefing.sections[0]?.heading).toBe("Market size");

    const skippedEvent = events.find((e) => e.phase === "cross-reference-skipped");
    expect(skippedEvent).toBeDefined();
    const synthMode = events.find((e) => e.phase === "synthesiser-start");
    expect(synthMode && "mode" in synthMode && synthMode.mode).toBe("deterministic");
  });
});

describe("orchestrateTopic — failure modes", () => {
  it("raises AllWorkersFailedError when every worker fails", async () => {
    const planner: CallLlm = vi.fn(async () => plannerJson);
    await expect(
      orchestrateTopic({
        ...baseOpts,
        plannerCallLlmChain: [planner],
        workers: [
          fakeProvider("claude-sub", "https://a.example.com", { rejects: true }),
          fakeProvider("gemini-sub", "https://b.example.com", { available: false }),
        ],
        crossReferenceCallLlm: vi.fn(),
        synthesiserCallLlm: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AllWorkersFailedError);
  });

  it("degrades gracefully when cross-reference fails — synthesiser still runs", async () => {
    const planner: CallLlm = vi.fn(async () => plannerJson);
    const crossRef: CallLlm = vi.fn(async () => "garbage not json");
    const synth: CallLlm = vi.fn(async () => synthJson);
    const events: OrchestrateProgress[] = [];

    const result = await orchestrateTopic({
      ...baseOpts,
      plannerCallLlmChain: [planner],
      workers: [
        fakeProvider("claude-sub", "https://a.example.com"),
        fakeProvider("gemini-sub", "https://b.example.com"),
      ],
      crossReferenceCallLlm: crossRef,
      synthesiserCallLlm: synth,
      onProgress: (e) => events.push(e),
    });

    expect(events.some((e) => e.phase === "cross-reference-degraded")).toBe(true);
    expect(synth).toHaveBeenCalledTimes(1);
    // Without cross-ref the briefing still goes through LLM synth (2 channels),
    // just without llmVerdicts attached.
    expect(result.briefing.sections[0]?.llmVerdicts).toBeUndefined();
    expect(result.briefing.synthesisedBy).toBe("claude-sub");
  });
});
