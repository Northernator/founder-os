/**
 * research_py provider tests.
 *
 * Drives the sidecar contract via a real ResearchClient pointed at a
 * mocked fetch — exercises the createDeepResearch → pollJob → readReport
 * flow end-to-end with no real HTTP and no real disk I/O. The disk read
 * is stubbed via opts.readReport.
 */
import { describe, expect, it, vi } from "vitest";
import { ResearchClient } from "@founder-os/research-runner";
import {
  createResearchPyProvider,
  ResearchPyInvocationError,
} from "../src/node.js";
import type { ResearchTopicOpts } from "@founder-os/research-deep-core";

const sampleTopic: ResearchTopicOpts = {
  topic: { slug: "competitors-top10", label: "Top-10 competitors in UK SaaS accounting" },
  questions: [
    {
      id: "q-1",
      question: "Who are the leading UK SaaS accounting platforms?",
      angle: "competitor",
      priority: "must",
    },
  ],
  ventureContext: "Indie founder targeting UK micro-businesses.",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

const reportMarkdown = `## Market leaders

Xero, FreeAgent, and QuickBooks dominate the UK micro-business accounting market.

**Sources consulted:**
- Statista UK accounting software share 2024, Statista, accessed 2026-05-18 — https://www.statista.com/uk-accounting-share-2024
`;

interface FetchScript {
  /** Body returned for POST /research/deep. */
  acceptance: { job_id: string; status: string; venture_slug: string; poll: string };
  /** Sequence of GET /research/jobs/{id} responses to return in order. */
  jobs: Array<unknown>;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedFetch(script: FetchScript): typeof fetch {
  let jobsCursor = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/research/deep")) {
      return makeJsonResponse(script.acceptance, 202);
    }
    if (method === "GET" && url.includes("/research/jobs/")) {
      const next = script.jobs[jobsCursor] ?? script.jobs[script.jobs.length - 1];
      jobsCursor++;
      return makeJsonResponse(next);
    }
    if (method === "GET" && url.endsWith("/health")) {
      return makeJsonResponse({ status: "ok" });
    }
    throw new Error(`scriptedFetch: unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function newClient(fetchImpl: typeof fetch): ResearchClient {
  return new ResearchClient({ baseUrl: "http://sidecar.test", fetchImpl, timeoutMs: 1000 });
}

describe("createResearchPyProvider", () => {
  it("requires ventureSlug", () => {
    expect(() =>
      createResearchPyProvider({
        ventureSlug: "",
        client: newClient(vi.fn() as unknown as typeof fetch),
      }),
    ).toThrow(/ventureSlug is required/);
  });

  it("requires either a client or a baseUrl", () => {
    expect(() =>
      createResearchPyProvider({ ventureSlug: "demo" }),
    ).toThrow(/client or opts.baseUrl/);
  });

  it("reports name=research_py", () => {
    const fetchImpl = scriptedFetch({
      acceptance: { job_id: "j-1", status: "queued", venture_slug: "demo", poll: "/jobs/j-1" },
      jobs: [],
    });
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
    });
    expect(p.name).toBe("research_py");
  });

  it("kicks off the job, polls to done, reads + parses the report", async () => {
    const fetchImpl = scriptedFetch({
      acceptance: { job_id: "j-1", status: "queued", venture_slug: "demo", poll: "/jobs/j-1" },
      jobs: [
        // First poll: running.
        {
          job_id: "j-1",
          kind: "deep_research",
          status: "running",
          venture_slug: "demo",
          created_at: "2026-05-18T09:00:00Z",
          updated_at: "2026-05-18T09:00:05Z",
          progress_message: "conducting research",
          result: null,
          error: null,
        },
        // Second poll: done with a result pointing at a disk path.
        {
          job_id: "j-1",
          kind: "deep_research",
          status: "done",
          venture_slug: "demo",
          created_at: "2026-05-18T09:00:00Z",
          updated_at: "2026-05-18T09:00:30Z",
          progress_message: "done",
          result: {
            venture_slug: "demo",
            output_path: "/tmp/report.md",
            sources_path: "/tmp/sources.json",
            summary_md_chars: reportMarkdown.length,
            sources_count: 1,
            sources: ["https://www.statista.com/uk-accounting-share-2024"],
          },
          error: null,
        },
      ],
    });

    const readReport = vi.fn(async () => reportMarkdown);
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
      pollIntervalMs: 5, // keep the test fast
      jobTimeoutMs: 2000,
      readReport,
    });

    const partial = await p.researchTopic(sampleTopic);
    expect(readReport).toHaveBeenCalledWith("/tmp/report.md");
    expect(partial.sections).toHaveLength(1);
    expect(partial.sections[0]?.heading).toBe("Market leaders");
    expect(partial.sources.every((s) => s.retrievedBy === "research_py")).toBe(true);
    // The first-party `sources` list from the job result is in the output.
    expect(partial.sources.map((s) => s.url)).toContain(
      "https://www.statista.com/uk-accounting-share-2024",
    );
  });

  it("throws ResearchPyInvocationError(rejected) when the POST fails", async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse({ detail: "bad slug" }, 400)) as unknown as typeof fetch;
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
    });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ResearchPyInvocationError",
      stage: "rejected",
    });
  });

  it("throws ResearchPyInvocationError(errored) when the job ends in error", async () => {
    const fetchImpl = scriptedFetch({
      acceptance: { job_id: "j-1", status: "queued", venture_slug: "demo", poll: "/jobs/j-1" },
      jobs: [
        {
          job_id: "j-1",
          kind: "deep_research",
          status: "error",
          venture_slug: "demo",
          created_at: "2026-05-18T09:00:00Z",
          updated_at: "2026-05-18T09:00:10Z",
          progress_message: "error",
          result: null,
          error: "TavilyError: rate limit",
        },
      ],
    });
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
      pollIntervalMs: 5,
      jobTimeoutMs: 2000,
    });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ResearchPyInvocationError",
      stage: "errored",
      message: expect.stringContaining("TavilyError"),
    });
  });

  it("throws ResearchPyInvocationError(read-failed) when the report file cannot be read", async () => {
    const fetchImpl = scriptedFetch({
      acceptance: { job_id: "j-1", status: "queued", venture_slug: "demo", poll: "/jobs/j-1" },
      jobs: [
        {
          job_id: "j-1",
          kind: "deep_research",
          status: "done",
          venture_slug: "demo",
          created_at: "2026-05-18T09:00:00Z",
          updated_at: "2026-05-18T09:00:30Z",
          progress_message: "done",
          result: {
            venture_slug: "demo",
            output_path: "/tmp/report.md",
            sources_path: "/tmp/sources.json",
            summary_md_chars: 0,
            sources_count: 0,
            sources: [],
          },
          error: null,
        },
      ],
    });
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
      pollIntervalMs: 5,
      jobTimeoutMs: 2000,
      readReport: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    await expect(p.researchTopic(sampleTopic)).rejects.toMatchObject({
      name: "ResearchPyInvocationError",
      stage: "read-failed",
    });
  });

  it("available() returns true when /health succeeds", async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse({ status: "ok" })) as unknown as typeof fetch;
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
    });
    expect(await p.available()).toBe(true);
  });

  it("available() returns false when /health throws", async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse({ detail: "down" }, 500)) as unknown as typeof fetch;
    const p = createResearchPyProvider({
      ventureSlug: "demo",
      client: newClient(fetchImpl),
    });
    expect(await p.available()).toBe(false);
  });

  it("ResearchPyInvocationError carries a stage tag", () => {
    const err = new ResearchPyInvocationError("timeout", "x");
    expect(err.stage).toBe("timeout");
  });
});
