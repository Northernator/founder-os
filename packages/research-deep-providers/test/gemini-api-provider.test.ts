/**
 * gemini-api provider tests.
 *
 * Pure unit tests against a mocked fetch. Asserts the generateContent
 * request envelope, the googleSearch tool wiring, the response parsing
 * (candidates[0].content.parts[].text), and that groundingMetadata URIs
 * are folded into the source set as first-party provenance.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createGeminiApiProvider,
  GEMINI_API_DEFAULT_MODEL,
} from "../src/index.js";
import type { ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "wcag-22", label: "WCAG 2.2 deltas vs 2.1" },
  questions: [
    {
      id: "q-1",
      question: "What new success criteria did WCAG 2.2 introduce?",
      angle: "regulatory",
      priority: "must",
    },
  ],
  ventureContext: "Building a UK B2B SaaS app; audit stage will check WCAG.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const proseMarkdown = `## WCAG 2.2 new criteria

WCAG 2.2 adds nine new success criteria including focus appearance and dragging movements.

**Sources consulted:**
- WCAG 2.2 Recommendation, W3C, accessed 2026-05-18 — https://www.w3.org/TR/WCAG22/
`;

function makeFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGeminiPayload(text: string, groundingUris: string[] = []) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }],
        },
        groundingMetadata: {
          groundingChunks: groundingUris.map((uri) => ({
            web: { uri, title: new URL(uri).hostname },
          })),
        },
      },
    ],
  };
}

describe("createGeminiApiProvider", () => {
  it("throws synchronously when apiKey is missing", () => {
    expect(() => createGeminiApiProvider({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("reports name=gemini-api", () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(makeGeminiPayload(proseMarkdown)),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    expect(p.name).toBe("gemini-api");
  });

  it("POSTs to /v1beta/models/<model>:generateContent with googleSearch tool", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(makeGeminiPayload(proseMarkdown)),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    await p.researchTopic(sampleTopic);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1beta/models/${encodeURIComponent(GEMINI_API_DEFAULT_MODEL)}:generateContent`);
    expect(String(url)).toContain("key=k-test");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(String(init?.body));
    expect(body.systemInstruction.parts[0].text).toContain("deep research analyst");
    expect(body.contents[0].parts[0].text).toContain("WCAG 2.2 deltas vs 2.1");
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("parses sections from text parts and stamps gemini-api on sources", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(makeGeminiPayload(proseMarkdown)),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    const partial = await p.researchTopic(sampleTopic);
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("WCAG 2.2 new criteria");
    expect(partial.sources.every((s) => s.retrievedBy === "gemini-api")).toBe(true);
  });

  it("folds groundingMetadata URIs into the source set (dedup by URL)", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(
        makeGeminiPayload(proseMarkdown, [
          "https://www.w3.org/TR/WCAG22/", // dupe of one in the prose
          "https://www.gov.uk/service-manual/helping-people-to-use-your-service",
        ]),
      ),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    const partial = await p.researchTopic(sampleTopic);
    const urls = partial.sources.map((s) => s.url);
    expect(urls).toContain("https://www.w3.org/TR/WCAG22/");
    expect(urls).toContain("https://www.gov.uk/service-manual/helping-people-to-use-your-service");
    // Dedup keeps each URL exactly once.
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("disables googleSearch when enableGoogleSearch=false", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(makeGeminiPayload(proseMarkdown)),
    );
    const p = createGeminiApiProvider({
      apiKey: "k-test",
      fetchImpl,
      enableGoogleSearch: false,
    });
    await p.researchTopic(sampleTopic);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools).toBeUndefined();
  });

  it("throws GeminiApiInvocationError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ error: { message: "quota exhausted" } }, 429),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "GeminiApiInvocationError",
      message: expect.stringContaining("HTTP 429"),
    });
  });

  it("throws GeminiApiInvocationError when no text parts are returned", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({
        candidates: [{ content: { parts: [{ functionCall: { name: "googleSearch" } }] } }],
      }),
    );
    const p = createGeminiApiProvider({ apiKey: "k-test", fetchImpl });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "GeminiApiInvocationError",
      message: expect.stringContaining("no text parts"),
    });
  });
});
