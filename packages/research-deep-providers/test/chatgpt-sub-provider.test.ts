/**
 * chatgpt-sub (paste-in) provider tests.
 *
 * Pure unit tests — the paste-in callback is a vi.fn(). No subprocess.
 */
import { describe, expect, it, vi } from "vitest";
import { createChatgptSubProvider } from "../src/index.js";
import type {
  RequestPasteIn,
  ResearchTopicOpts,
} from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "regulatory-uk", label: "UK regulatory landscape" },
  questions: [
    {
      id: "q-1",
      question: "What does HMRC require from UK SaaS startups in year one?",
      angle: "regulatory",
      priority: "must",
    },
  ],
  ventureContext: "Sole-trader SaaS founder, pre-incorporation.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const pastedMarkdown = `## HMRC requirements

Self-employed founders register with HMRC within 3 months of starting trade.

**Sources consulted:**
- Self-employed: register, gov.uk, accessed 2026-05-18 — https://www.gov.uk/register-self-employed
`;

describe("createChatgptSubProvider", () => {
  it("always reports available()=true (paste-in is the never-fails channel)", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({
      kind: "skipped",
    }));
    const p = createChatgptSubProvider({ requestPaste });
    expect(await p.available()).toBe(true);
  });

  it("emits the paste-in prompt with the channel hint to the callback", async () => {
    const requestPaste = vi.fn(async () => ({
      kind: "pasted" as const,
      markdown: pastedMarkdown,
    }));
    const p = createChatgptSubProvider({ requestPaste });
    await p.researchTopic(sampleTopic);
    expect(requestPaste).toHaveBeenCalledTimes(1);
    const req = requestPaste.mock.calls[0]?.[0];
    expect(req?.channel).toBe("chatgpt-sub");
    expect(req?.topicSlug).toBe("regulatory-uk");
    expect(req?.promptMarkdown).toContain("UK regulatory landscape");
    expect(req?.promptMarkdown).toContain("ChatGPT (use Deep Research mode)");
  });

  it("parses a pasted response into sections + sources", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({
      kind: "pasted",
      markdown: pastedMarkdown,
    }));
    const p = createChatgptSubProvider({ requestPaste });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("HMRC requirements");
    expect(partial.sources).toHaveLength(1);
    expect(partial.sources[0]?.retrievedBy).toBe("chatgpt-sub");
  });

  it("returns an empty partial with every question marked unanswered when skipped", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({
      kind: "skipped",
      reason: "not at desk",
    }));
    const p = createChatgptSubProvider({ requestPaste });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toEqual([]);
    expect(partial.sources).toEqual([]);
    expect(partial.unanswered).toEqual([
      "What does HMRC require from UK SaaS startups in year one?",
    ]);
    expect(partial.rawTranscript).toMatchObject({
      channel: "chatgpt-sub",
      skipped: true,
      reason: "not at desk",
    });
  });

  it("honours channelOverride (used by createPasteInProvider)", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({
      kind: "pasted",
      markdown: pastedMarkdown,
    }));
    const p = createChatgptSubProvider({
      requestPaste,
      channelOverride: "paste-in",
      channelHint: "any LLM with web search",
    });
    expect(p.name).toBe("paste-in");
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sources[0]?.retrievedBy).toBe("paste-in");
    expect(partial.sources[0]?.trustTier).toBe("tertiary");
  });
});
