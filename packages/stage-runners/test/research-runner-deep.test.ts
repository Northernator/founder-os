import { describe, expect, it, vi } from "vitest";
import type { ResearchBriefing } from "@founder-os/research-deep-core";
import { ResearchStageRunner } from "../src/runners/research-runner.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

function briefingFor(slug: string, label: string): ResearchBriefing {
  return {
    ventureSlug: "test",
    topicSlug: slug,
    topicLabel: label,
    questions: [{ id: "q1", question: "What matters?", angle: "market", priority: "must" }],
    sections: [
      {
        heading: `${label} finding`,
        body: `Sourced finding for ${label}.`,
        sources: [`https://example.com/${slug}`],
      },
    ],
    sources: [
      {
        url: `https://example.com/${slug}`,
        title: `${label} source`,
        accessedAt: "2026-05-18T00:00:00.000Z",
        retrievedBy: "claude-sub",
        trustTier: "secondary",
      },
    ],
    channelsUsed: ["claude-sub"],
    crossReferencedBy: [],
    disagreements: [],
    unanswered: [],
    generatedAt: "2026-05-18T00:00:00.000Z",
    staleAfterDays: 30,
  };
}

const { orchestrateTopic } = vi.hoisted(() => ({
  orchestrateTopic: vi.fn(
    async (opts: { topic: { slug: string; label: string }; onProgress?: (event: { phase: string; topicSlug: string }) => void }) => {
    if (opts.topic.slug === "launch-plan") throw new Error("launch research failed");
    opts.onProgress?.({ phase: "synthesiser-done", topicSlug: opts.topic.slug });
    return {
      briefing: briefingFor(opts.topic.slug, opts.topic.label),
      plan: { questions: [], fallbackIndex: 0 },
      transcripts: {
        planner: { topic: opts.topic.slug },
        crossReference: null,
        synthesiser: null,
        workers: { outcomes: [], successes: new Map(), failures: new Map() },
      },
    };
    }
  ),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const noopLlm = async () => "{}";

describe("ResearchStageRunner deep-research adoption", () => {
  it("writes legacy 01_research/saas markdowns from deep-research briefings", async () => {
    const fs = new InMemoryFs();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "saas" }),
      ventureRoot: "/v",
      fs,
      intake: "Founder intake",
      callLlm: noopLlm,
      workers: [],
      runId: "run-1",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(fs.files.get("v/01_research/saas/market-research.md")).toContain("Sources consulted");
    expect(fs.files.has("/v/00_research/deep/briefings/market-research.json")).toBe(true);
    expect(fs.files.has("v/01_research/saas/launch-plan.md")).toBe(false);
    expect(result.logs.map((l) => l.message)).toContain("failed launch-plan.md");
  });

  it("skips existing legacy markdowns before calling the orchestrator", async () => {
    const fs = new InMemoryFs();
    fs.files.set("v/01_research/saas/market-research.md", "# Existing\n");
    orchestrateTopic.mockClear();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "saas" }),
      ventureRoot: "/v",
      fs,
      intake: "Founder intake",
      callLlm: noopLlm,
      workers: [],
      runId: "run-1",
    });

    await runner.run();

    expect(orchestrateTopic.mock.calls.some(([arg]) => arg.topic.slug === "market-research")).toBe(false);
    expect(fs.files.get("v/01_research/saas/market-research.md")).toBe("# Existing\n");
  });
});
