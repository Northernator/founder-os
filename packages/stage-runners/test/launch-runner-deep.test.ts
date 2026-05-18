import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const launchStepSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "launch-channel-benchmarks",
    topicLabel: "Launch channel benchmarks and PR template current state",
    questions: [
      {
        id: "q-launch-channel-benchmarks",
        question: "Current ad CPC benchmarks?",
        angle: "market",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Channel benchmarks",
        body: "Search CPCs in UK B2B SaaS land around GBP 4-9 per click in this category right now.",
        sources: ["https://example.com/cpc"],
      },
    ],
    sources: [
      {
        url: "https://example.com/cpc",
        title: "Channel CPCs",
        publisher: "Example",
        accessedAt: "2026-05-18T00:00:00.000Z",
        retrievedBy: "claude-sub",
        trustTier: "secondary",
      },
    ],
    channelsUsed: ["claude-sub"],
    crossReferencedBy: [],
    synthesisedBy: "claude-sub",
    disagreements: [],
    unanswered: [],
    generatedAt: "2026-05-18T00:00:00.000Z",
    staleAfterDays: 7,
  },
  plan: { questions: [], fallbackIndex: 0 },
  transcripts: {
    planner: null,
    crossReference: null,
    synthesiser: null,
    workers: { outcomes: [], successes: new Map(), failures: new Map() },
  },
}));

vi.mock("@founder-os/pipeline-runner", () => ({
  createLaunchPackageStep: (ctx: unknown) => launchStepSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { LaunchStageRunner } = await import("../src/runners/launch-runner.js");

function defaultStepResult(): Record<string, unknown> {
  return {
    status: "done",
    receiptPath: "/v/08_launch/launch-receipt.json",
    announcementPath: "/v/08_launch/launch-announcement.md",
    receipt: {
      schemaVersion: 1,
      stage: "LAUNCH",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      ventureSlug: "test",
      launchedAt: "2026-05-18T00:00:00.000Z",
      status: "checkpoint",
      deploymentUrl: null,
      versionTag: null,
      buildRunId: null,
      brand: { name: null, tagline: null, targetAudience: null },
      validation: { decision: null, icp: null },
      pricing: { pricePoint: null, pricingModel: null, fundingRecommendation: null },
      ukSetup: { entityType: "ltd", hasUkSetupCanvas: false },
      build: { hasHandoff: false },
      preLaunchChecklist: [],
      sources: [],
      generationSource: "deterministic",
    },
  };
}

describe("LaunchStageRunner deep research adoption", () => {
  it("gathers and indexes a launch channel benchmarks briefing when enabled", async () => {
    orchestrateTopic.mockClear();
    launchStepSpy.mockReset();
    launchStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder launching a UK SaaS for SMEs.");
    const runner = new LaunchStageRunner({
      manifest: makeManifest({ industry: "B2B SaaS", takesPayments: true }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub announcement",
      enableDeepResearch: true,
      runId: "run-launch",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/launch-channel-benchmarks.md",
        "/v/00_research/deep/briefings/launch-channel-benchmarks.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("launch deep-research ready");

    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("launch-channel-benchmarks");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("takesPayments=true");

    expect(launchStepSpy).toHaveBeenCalledTimes(1);
    const stepCtx = launchStepSpy.mock.calls[0]?.[0] as {
      deepResearch?: { filename: string; excerpt: string }[];
    };
    expect(stepCtx.deepResearch).toBeDefined();
    expect(stepCtx.deepResearch?.[0]?.filename).toBe("launch-channel-benchmarks.md");
    expect(stepCtx.deepResearch?.[0]?.excerpt).toContain("Channel benchmarks");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("launch-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic launch path when not enabled", async () => {
    orchestrateTopic.mockClear();
    launchStepSpy.mockReset();
    launchStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    const runner = new LaunchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-launch",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    const stepCtx = launchStepSpy.mock.calls[0]?.[0] as {
      deepResearch?: unknown;
    };
    expect(stepCtx.deepResearch).toBeUndefined();
  });

  it("skips deep research when no callLlm provided, still succeeds deterministically", async () => {
    orchestrateTopic.mockClear();
    launchStepSpy.mockReset();
    launchStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    const runner = new LaunchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      enableDeepResearch: true,
      runId: "run-launch",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
