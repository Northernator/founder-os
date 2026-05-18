/**
 * chatgpt-api provider tests.
 *
 * Tests the Responses-API envelope, web_search_preview tool wiring, the
 * dual extraction path (output_text shortcut vs nested output[].content[]),
 * and error mapping.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CHATGPT_API_DEFAULT_MODEL,
  createChatgptApiProvider,
} from "../src/index.js";
import type { ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "icp", label: "ICP for indie SaaS targeting UK accountants" },
  questions: [
    {
      id: "q-1",
      question: "What are the buying triggers for UK accountants adopting new SaaS?",
      angle: "customer",
      priority: "must",
    },
  ],
  ventureContext: "Indie SaaS founder, pre-launch, targeting UK accounting firms.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const markdownReply = `## Buying triggers

UK accountants frequently change software during the year-end audit cycle and around Making Tax Digital deadlines.

**Sources consulted:**
- ICAEW Tech faculty annual survey 2024, ICAEW, accessed 2026-05-18 — https://www.icaew.com/insights/tech-survey-2024
`;

function makeFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createChatgptApiProvider", () => {
  it("throws synchronously when apiKey is missing", () => {
    expect(() => createChatgptApiProvider({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("reports name=chatgpt-api", () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ output_text: markdownReply }));
    const p = createChatgptApiProvider({ apiKey: "sk-test", fetchImpl });
    expect(p.name).toBe("chatgpt-api");
  });

  it("POSTs to /v1/responses with web_search_preview tool + bearer auth", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ output_text: markdownReply }));
    const p = createChatgptApiProvider({
      apiKey: "sk-test",
      organization: "org-1",
      fetchImpl,
    });
    await p.researchTopic(sampleTopic);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["OpenAI-Organization"]).toBe("org-1");

    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(CHATGPT_API_DEFAULT_MODEL);
    expect(body.instructions).toContain("deep research analyst");
    expect(body.input).toContain("UK accountants");
    expect(body.tools).toEqual([{ type: "web_search_preview" }]);
  });

  it("uses the output_text convenience field when present", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ output_text: markdownReply }));
    const p = createChatgptApiProvider({ apiKey: "sk-test", fetchImpl });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("Buying triggers");
    expect(partial.sources.every((s) => s.retrievedBy === "chatgpt-api")).toBe(true);
  });

  it("falls back to walking output[].content[] when output_text is absent", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "## Buying triggers\n\nIntro text.\n" },
              {
                type: "output_text",
                text:
                  "**Sources consulted:**\n" +
                  "- ICAEW Tech faculty annual survey 2024, ICAEW, accessed 2026-05-18 — https://www.icaew.com/insights/tech-survey-2024\n",
              },
            ],
          },
        ],
      }),
    );
    const p = createChatgptApiProvider({ apiKey: "sk-test", fetchImpl });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sources).toHaveLength(1);
    expect(partial.sources[0]?.url).toBe("https://www.icaew.com/insights/tech-survey-2024");
  });

  it("disables web_search when enableWebSearch=false", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ output_text: markdownReply }));
    const p = createChatgptApiProvider({
      apiKey: "sk-test",
      fetchImpl,
      enableWebSearch: false,
    });
    await p.researchTopic(sampleTopic);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools).toBeUndefined();
  });

  it("throws ChatgptApiInvocationError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ error: { message: "insufficient_quota" } }, 429),
    );
    const p = createChatgptApiProvider({ apiKey: "sk-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ChatgptApiInvocationError",
      message: expect.stringContaining("HTTP 429"),
    });
  });

  it("throws ChatgptApiInvocationError when no output_text content is present", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({
        output: [{ type: "tool_call", id: "call-1", name: "web_search" }],
      }),
    );
    const p = createChatgptApiProvider({ apiKey: "sk-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ChatgptApiInvocationError",
      message: expect.stringContaining("no output_text"),
    });
  });
});
