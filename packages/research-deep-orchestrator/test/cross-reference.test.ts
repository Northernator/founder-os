/**
 * Cross-reference tests.
 *
 * The cross-referencer asks Claude (via the injected CallLlm) to read N
 * partials and emit JSON verdicts + disagreement lines. Tests assert
 * happy path, schema validation, and the < 2 partials guard.
 */
import { describe, expect, it, vi } from "vitest";
import { CrossReferenceError, crossReference } from "../src/index.js";
import type {
  CallLlm,
  ProviderPartial,
  ResearchChannel,
} from "@founder-os/research-deep-core";

function fakePartial(channel: ResearchChannel, body: string): ProviderPartial {
  return {
    sections: [
      {
        heading: "Market size",
        body,
        sources: [`https://example.com/${channel}`],
      },
    ],
    sources: [
      {
        url: `https://example.com/${channel}`,
        title: `Source for ${channel}`,
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
  topic: { slug: "t", label: "Market size" },
  partials: [
    { channel: "claude-sub" as ResearchChannel, partial: fakePartial("claude-sub", "x") },
    { channel: "gemini-sub" as ResearchChannel, partial: fakePartial("gemini-sub", "y") },
  ],
};

describe("crossReference", () => {
  it("returns disagreements + per-section verdicts from the LLM JSON", async () => {
    const json = JSON.stringify({
      verdicts: [
        { heading: "Market size", channel: "claude-sub", agreed: true, contradicted: null },
        {
          heading: "Market size",
          channel: "gemini-sub",
          agreed: false,
          contradicted: "Gemini said the market is 20% larger.",
        },
      ],
      disagreements: ["claude-sub and gemini-sub disagree on the 2026 market size."],
    });
    const caller: CallLlm = vi.fn(async () => json);
    const result = await crossReference(baseInput, { callLlm: caller });
    expect(result.disagreements).toHaveLength(1);
    const verdicts = result.verdictsByHeading.get("Market size");
    expect(verdicts?.["claude-sub"]?.agreed).toBe(true);
    expect(verdicts?.["gemini-sub"]?.agreed).toBe(false);
    expect(verdicts?.["gemini-sub"]?.contradicted).toContain("20% larger");
  });

  it("returns no disagreements + agreed verdicts when LLM reports consensus", async () => {
    const json = JSON.stringify({
      verdicts: [
        { heading: "Market size", channel: "claude-sub", agreed: true },
        { heading: "Market size", channel: "gemini-sub", agreed: true },
      ],
      disagreements: [],
    });
    const caller: CallLlm = vi.fn(async () => json);
    const result = await crossReference(baseInput, { callLlm: caller });
    expect(result.disagreements).toHaveLength(0);
    expect(result.verdictsByHeading.get("Market size")?.["claude-sub"]?.contradicted).toBeUndefined();
  });

  it("throws CrossReferenceError when fewer than 2 partials are supplied", async () => {
    const caller: CallLlm = vi.fn(async () => "{}");
    await expect(
      crossReference(
        {
          topic: baseInput.topic,
          partials: [baseInput.partials[0]!],
        },
        { callLlm: caller },
      ),
    ).rejects.toBeInstanceOf(CrossReferenceError);
    expect(caller).not.toHaveBeenCalled();
  });

  it("throws CrossReferenceError on schema-invalid LLM output", async () => {
    const caller: CallLlm = vi.fn(async () =>
      JSON.stringify({ verdicts: [{ heading: "h", channel: "not-a-real-channel", agreed: true }] }),
    );
    await expect(
      crossReference(baseInput, { callLlm: caller }),
    ).rejects.toBeInstanceOf(CrossReferenceError);
  });
});
