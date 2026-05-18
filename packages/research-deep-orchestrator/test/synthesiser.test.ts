/**
 * Synthesiser tests.
 *
 * Multi-channel path goes through the injected CallLlm; single-channel
 * is deterministic passthrough (no LLM call). Tests cover both paths +
 * the URL-hallucination prune.
 */
import { describe, expect, it, vi } from "vitest";
import { SynthesiserError, synthesise } from "../src/index.js";
import type {
  CallLlm,
  ProviderPartial,
  ResearchChannel,
} from "@founder-os/research-deep-core";

function partial(channel: ResearchChannel, url: string): ProviderPartial {
  return {
    sections: [
      {
        heading: "Market size",
        body: `findings from ${channel}`,
        sources: [url],
      },
    ],
    sources: [
      {
        url,
        title: `Source from ${channel}`,
        accessedAt: "2026-05-18T09:00:00.000Z",
        retrievedBy: channel,
        trustTier: "secondary",
      },
    ],
    unanswered: [],
    rawTranscript: null,
  };
}

const baseInput = {
  ventureSlug: "acme-saas",
  topic: { slug: "market-size", label: "UK SaaS market size" },
  ventureContext: "Solo founder.",
  questions: [
    {
      id: "q-1",
      question: "What is the UK SaaS market size in 2026?",
      angle: "market" as const,
      priority: "must" as const,
    },
  ],
  generatedAt: "2026-05-18T10:00:00.000Z",
};

describe("synthesise — single-channel deterministic path", () => {
  it("passes the lone partial's sections through without calling the LLM", async () => {
    const callLlm: CallLlm = vi.fn();
    const result = await synthesise(
      {
        ...baseInput,
        partials: [
          { channel: "claude-sub", partial: partial("claude-sub", "https://a.example.com") },
        ],
      },
      { callLlm },
    );
    expect(callLlm).not.toHaveBeenCalled();
    expect(result.rawResponse).toBeNull();
    expect(result.briefing.channelsUsed).toEqual(["claude-sub"]);
    expect(result.briefing.crossReferencedBy).toEqual([]);
    expect(result.briefing.synthesisedBy).toBeUndefined();
    expect(result.briefing.sections).toHaveLength(1);
    expect(result.briefing.sources).toHaveLength(1);
  });

  it("propagates unanswered questions from the single partial", async () => {
    const callLlm: CallLlm = vi.fn();
    const onePartial = partial("gemini-sub", "https://b.example.com");
    onePartial.unanswered = ["Q1 unanswered?"];
    const result = await synthesise(
      { ...baseInput, partials: [{ channel: "gemini-sub", partial: onePartial }] },
      { callLlm },
    );
    expect(result.briefing.unanswered).toEqual(["Q1 unanswered?"]);
  });
});

describe("synthesise — multi-channel LLM path", () => {
  it("merges partials and attaches cross-reference verdicts", async () => {
    const synthJson = JSON.stringify({
      sections: [
        {
          heading: "Market size",
          body: "Merged market-size prose drawing on both channels.",
          sources: ["https://a.example.com", "https://b.example.com"],
        },
      ],
      unanswered: [],
    });
    const callLlm: CallLlm = vi.fn(async () => synthJson);
    const verdictsByHeading = new Map([
      [
        "Market size",
        {
          "claude-sub": { agreed: true, addedSources: [] },
          "gemini-sub": { agreed: true, addedSources: [] },
        },
      ],
    ]);
    const result = await synthesise(
      {
        ...baseInput,
        partials: [
          { channel: "claude-sub", partial: partial("claude-sub", "https://a.example.com") },
          { channel: "gemini-sub", partial: partial("gemini-sub", "https://b.example.com") },
        ],
        verdictsByHeading,
        disagreements: ["everyone agreed actually"],
      },
      { callLlm },
    );
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(result.briefing.channelsUsed).toEqual(["claude-sub", "gemini-sub"]);
    expect(result.briefing.crossReferencedBy).toEqual(["claude-sub"]);
    expect(result.briefing.synthesisedBy).toBe("claude-sub");
    expect(result.briefing.sections[0]?.llmVerdicts?.["claude-sub"]?.agreed).toBe(true);
    expect(result.briefing.sources).toHaveLength(2);
    expect(result.briefing.disagreements).toEqual(["everyone agreed actually"]);
  });

  it("drops hallucinated source URLs not present in any worker partial", async () => {
    const synthJson = JSON.stringify({
      sections: [
        {
          heading: "Market size",
          body: "Merged prose.",
          sources: ["https://a.example.com", "https://hallucinated.example.com"],
        },
      ],
      unanswered: [],
    });
    const callLlm: CallLlm = vi.fn(async () => synthJson);
    const result = await synthesise(
      {
        ...baseInput,
        partials: [
          { channel: "claude-sub", partial: partial("claude-sub", "https://a.example.com") },
          { channel: "gemini-sub", partial: partial("gemini-sub", "https://b.example.com") },
        ],
      },
      { callLlm },
    );
    expect(result.briefing.sections[0]?.sources).toEqual(["https://a.example.com"]);
  });

  it("throws SynthesiserError on schema-invalid LLM output", async () => {
    const callLlm: CallLlm = vi.fn(async () =>
      JSON.stringify({ sections: [{ heading: "", body: "x", sources: [] }] }),
    );
    await expect(
      synthesise(
        {
          ...baseInput,
          partials: [
            { channel: "claude-sub", partial: partial("claude-sub", "https://a.example.com") },
            { channel: "gemini-sub", partial: partial("gemini-sub", "https://b.example.com") },
          ],
        },
        { callLlm },
      ),
    ).rejects.toBeInstanceOf(SynthesiserError);
  });

  it("dedupes sources by URL across partials", async () => {
    const synthJson = JSON.stringify({
      sections: [{ heading: "Market size", body: "prose", sources: ["https://shared.example.com"] }],
      unanswered: [],
    });
    const callLlm: CallLlm = vi.fn(async () => synthJson);
    const result = await synthesise(
      {
        ...baseInput,
        partials: [
          { channel: "claude-sub", partial: partial("claude-sub", "https://shared.example.com") },
          { channel: "gemini-sub", partial: partial("gemini-sub", "https://shared.example.com") },
        ],
      },
      { callLlm },
    );
    expect(result.briefing.sources).toHaveLength(1);
    expect(result.briefing.sources[0]?.url).toBe("https://shared.example.com");
  });
});
