/**
 * Parallel-workers tests.
 *
 * The worker module fans out across N pre-built ResearchProvider
 * instances. Tests stub the providers with vi.fn()-backed objects and
 * assert that:
 *   - all-success: every channel's partial is collected
 *   - mixed: one rejection doesn't sink the rest
 *   - all-fail: returns 0 successes (orchestrator will turn this into AllWorkersFailedError)
 */
import { describe, expect, it, vi } from "vitest";
import { runParallelWorkers } from "../src/index.js";
import type {
  ProviderPartial,
  ResearchChannel,
  ResearchProvider,
} from "@founder-os/research-deep-core";

function fakePartial(channel: ResearchChannel): ProviderPartial {
  return {
    sections: [
      {
        heading: "Section A",
        body: `body from ${channel}`,
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
    rawTranscript: { channel },
  };
}

function fakeProvider(
  name: ResearchChannel,
  behaviour: {
    available?: boolean | (() => Promise<boolean>);
    research?: () => Promise<ProviderPartial>;
  } = {},
): ResearchProvider {
  return {
    name,
    available: vi.fn(async () => {
      if (typeof behaviour.available === "function") return behaviour.available();
      return behaviour.available ?? true;
    }),
    researchTopic: vi.fn(async () => {
      if (behaviour.research) return behaviour.research();
      return fakePartial(name);
    }),
  };
}

const baseInput = {
  topic: { slug: "t", label: "Topic" },
  questions: [],
  ventureContext: "ctx",
  accessedAt: "2026-05-18T09:00:00.000Z",
};

describe("runParallelWorkers", () => {
  it("collects partials from every available provider in parallel", async () => {
    const providers = [
      fakeProvider("claude-sub"),
      fakeProvider("gemini-sub"),
      fakeProvider("chatgpt-sub"),
    ];
    const result = await runParallelWorkers(providers, baseInput);
    expect(result.successes.size).toBe(3);
    expect(result.failures.size).toBe(0);
    expect(result.outcomes).toHaveLength(3);
  });

  it("records unavailable providers as failures and does not call researchTopic", async () => {
    const unavailable = fakeProvider("gemini-sub", { available: false });
    const ok = fakeProvider("claude-sub");
    const result = await runParallelWorkers([unavailable, ok], baseInput);
    expect(result.successes.has("claude-sub")).toBe(true);
    expect(result.failures.get("gemini-sub")?.reason).toBe("unavailable");
    expect(unavailable.researchTopic).not.toHaveBeenCalled();
  });

  it("isolates one provider's rejection from the others", async () => {
    const failing = fakeProvider("chatgpt-sub", {
      research: async () => {
        throw new Error("network");
      },
    });
    const ok1 = fakeProvider("claude-sub");
    const ok2 = fakeProvider("gemini-sub");
    const result = await runParallelWorkers([failing, ok1, ok2], baseInput);
    expect(result.successes.size).toBe(2);
    expect(result.failures.size).toBe(1);
    expect(result.failures.get("chatgpt-sub")?.reason).toBe("errored");
  });

  it("treats an available()-throw as unavailable rather than fatal", async () => {
    const throwing = fakeProvider("claude-sub", {
      available: () => {
        throw new Error("probe boom");
      },
    });
    const ok = fakeProvider("gemini-sub");
    const result = await runParallelWorkers([throwing, ok], baseInput);
    expect(result.failures.get("claude-sub")?.reason).toBe("unavailable");
    expect(result.successes.has("gemini-sub")).toBe(true);
  });

  it("returns zero successes when every provider fails — orchestrator turns this into AllWorkersFailedError", async () => {
    const a = fakeProvider("claude-sub", {
      research: async () => {
        throw new Error("a");
      },
    });
    const b = fakeProvider("gemini-sub", { available: false });
    const result = await runParallelWorkers([a, b], baseInput);
    expect(result.successes.size).toBe(0);
    expect(result.failures.size).toBe(2);
  });
});
