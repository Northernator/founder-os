/**
 * claude-api provider tests.
 *
 * No real network. We pass a vi.fn() as fetchImpl and assert the request
 * envelope, the response parsing (text + interleaved tool_use blocks),
 * the error mapping, and that the resulting partial round-trips through
 * the shared parser with channel="claude-api".
 */
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeApiInvocationError,
  CLAUDE_API_DEFAULT_MODEL,
  createClaudeApiProvider,
} from "../src/index.js";
import type { ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "uk-vat-thresholds", label: "UK VAT thresholds for SaaS" },
  questions: [
    {
      id: "q-1",
      question: "What is the current UK VAT registration threshold?",
      angle: "regulatory",
      priority: "must",
    },
    {
      id: "q-2",
      question: "When does the threshold update for the next tax year?",
      angle: "regulatory",
      priority: "should",
    },
  ],
  ventureContext: "Indie UK SaaS founder pre-revenue, planning incorporation.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const goodMarkdown = `## VAT threshold

The UK VAT registration threshold sits at £90,000 of taxable turnover as of April 2024.

**Sources consulted:**
- HMRC VAT registration thresholds, gov.uk, accessed 2026-05-18 — https://www.gov.uk/vat-registration-thresholds

## Next update

HMRC reviews thresholds annually at the Spring Budget; the 2026 threshold review is expected in March 2026.

**Sources consulted:**
- HMRC Spring Budget timeline, gov.uk, accessed 2026-05-18 — https://www.gov.uk/government/publications/spring-budget-2026
`;

function makeFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createClaudeApiProvider", () => {
  it("throws synchronously when apiKey is missing", () => {
    expect(() => createClaudeApiProvider({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("reports name=claude-api", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ content: [{ type: "text", text: goodMarkdown }] }),
    );
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    expect(p.name).toBe("claude-api");
  });

  it("sends a /v1/messages request with the right envelope + web_search tool", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ content: [{ type: "text", text: goodMarkdown }] }),
    );
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    await p.researchTopic(sampleTopic);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(CLAUDE_API_DEFAULT_MODEL);
    expect(body.system).toContain("deep research analyst");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("UK VAT thresholds for SaaS");
    expect(body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
  });

  it("parses interleaved text blocks (text + server_tool_use + text)", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({
        content: [
          { type: "text", text: "## VAT threshold\n\nThe UK VAT threshold is £90,000.\n" },
          {
            type: "server_tool_use",
            id: "tu-1",
            name: "web_search",
            input: { query: "uk vat registration threshold 2026" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "tu-1",
            content: [{ type: "web_search_result", url: "https://www.gov.uk/vat-registration-thresholds" }],
          },
          {
            type: "text",
            text:
              "**Sources consulted:**\n" +
              "- HMRC VAT registration thresholds, gov.uk, accessed 2026-05-18 — https://www.gov.uk/vat-registration-thresholds\n",
          },
        ],
      }),
    );
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("VAT threshold");
    expect(partial.sources).toHaveLength(1);
    expect(partial.sources[0]?.retrievedBy).toBe("claude-api");
    expect(partial.sources[0]?.accessedAt).toBe(sampleTopic.accessedAt);
  });

  it("disables web_search when enableWebSearch=false", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ content: [{ type: "text", text: goodMarkdown }] }),
    );
    const p = createClaudeApiProvider({
      apiKey: "sk-test",
      fetchImpl,
      enableWebSearch: false,
    });
    await p.researchTopic(sampleTopic);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools).toBeUndefined();
  });

  it("throws ClaudeApiInvocationError on non-2xx with Anthropic error body", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(
        {
          type: "error",
          error: { type: "rate_limit_error", message: "rate limit exceeded" },
        },
        429,
      ),
    );
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ClaudeSubInvocationError",
      message: expect.stringContaining("HTTP 429"),
    });
  });

  it("ClaudeApiInvocationError alias points at the same class as the sub-provider's", () => {
    // The factory re-exports under the API alias for ergonomics; the
    // orchestrator catches by class. Confirm the alias resolves cleanly.
    expect(ClaudeApiInvocationError.name).toBe("ClaudeSubInvocationError");
  });

  it("throws ClaudeSubInvocationError when response has no text blocks", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({
        content: [{ type: "server_tool_use", id: "tu-1", name: "web_search", input: {} }],
      }),
    );
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ClaudeSubInvocationError",
      message: expect.stringContaining("no text content"),
    });
  });

  it("honours baseUrl override (e.g. for proxy / staging)", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ content: [{ type: "text", text: goodMarkdown }] }),
    );
    const p = createClaudeApiProvider({
      apiKey: "sk-test",
      fetchImpl,
      baseUrl: "https://proxy.example.com/anthropic/",
    });
    await p.researchTopic(sampleTopic);
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://proxy.example.com/anthropic/v1/messages");
  });

  it("available() returns true when probe is omitted", async () => {
    const fetchImpl = vi.fn();
    const p = createClaudeApiProvider({ apiKey: "sk-test", fetchImpl });
    expect(await p.available()).toBe(true);
  });
});
