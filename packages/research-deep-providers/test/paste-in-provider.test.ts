/**
 * Generic paste-in provider tests.
 *
 * createPasteInProvider is a thin re-export of createChatgptSubProvider
 * with the channel tag swapped to "paste-in". This test pins the channel
 * tag, the tertiary-trust default, and the always-true available().
 */
import { describe, expect, it, vi } from "vitest";
import { createPasteInProvider } from "../src/index.js";
import type {
  RequestPasteIn,
  ResearchTopicOpts,
} from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "competitors-top-3", label: "Top 3 competitors" },
  questions: [
    {
      id: "q-1",
      question: "Who are the top three competitors?",
      angle: "competitor",
      priority: "must",
    },
  ],
  ventureContext: "Project management SaaS for UK marketing agencies.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const pasted = `## Competitor landscape

The market is led by Asana and Monday, with ClickUp gaining share.

**Sources consulted:**
- Asana pricing, asana.com, accessed 2026-05-18 — https://asana.com/pricing
- Monday.com pricing, monday.com, accessed 2026-05-18 — https://monday.com/pricing
`;

describe("createPasteInProvider", () => {
  it("tags the channel as paste-in", () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({ kind: "skipped" }));
    const p = createPasteInProvider({ requestPaste });
    expect(p.name).toBe("paste-in");
  });

  it("always reports available()=true", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({ kind: "skipped" }));
    const p = createPasteInProvider({ requestPaste });
    expect(await p.available()).toBe(true);
  });

  it("stamps tertiary trust tier on pasted-in sources", async () => {
    const requestPaste: RequestPasteIn = vi.fn(async () => ({
      kind: "pasted",
      markdown: pasted,
    }));
    const p = createPasteInProvider({ requestPaste });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sources).toHaveLength(2);
    for (const src of partial.sources) {
      expect(src.trustTier).toBe("tertiary");
      expect(src.retrievedBy).toBe("paste-in");
    }
  });

  it("uses the neutral channel hint by default", async () => {
    const requestPaste = vi.fn(async () => ({ kind: "skipped" as const }));
    const p = createPasteInProvider({ requestPaste });
    await p.researchTopic(sampleTopic);
    const req = requestPaste.mock.calls[0]?.[0];
    expect(req?.promptMarkdown).toMatch(/any LLM with web search/i);
  });
});
