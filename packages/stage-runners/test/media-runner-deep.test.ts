import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const scriptSpy = vi.fn();
const storyboardSpy = vi.fn();
const renderSpy = vi.fn();
const stitchSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "media-format-conventions",
    topicLabel: "Per-platform format conventions and hook patterns for launch reels",
    questions: [
      {
        id: "q-media-format-conventions",
        question: "Per-platform format conventions?",
        angle: "technical",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Format conventions",
        body: "TikTok favors 9:16 vertical reels around 15-30s with the hook in the first 1.5s.",
        sources: ["https://example.com/media-formats"],
      },
    ],
    sources: [
      {
        url: "https://example.com/media-formats",
        title: "Platform formats",
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
  createMediaScriptStep: (ctx: unknown) => scriptSpy(ctx),
  createStoryboardStep: (ctx: unknown) => storyboardSpy(ctx),
  createRenderShotsStep: (ctx: unknown) => renderSpy(ctx),
  createStitchStep: (ctx: unknown) => stitchSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { MediaStageRunner } = await import("../src/runners/media-runner.js");

const okScript = {
  status: "done" as const,
  jsonPath: "/v/10_media/scripts/media-script.json",
  mdPath: "/v/10_media/scripts/media-script.md",
  generationSource: "llm" as const,
  sources: ["launch-announcement.md", "media-format-conventions.md"],
  script: {
    schemaVersion: 1 as const,
    ventureSlug: "test",
    intent: "IDEA_TO_VIDEO" as const,
    scenes: [
      { id: "scene-1", durationSec: 6, voiceover: "v1", onScreen: "Title", visualBrief: "Title card" },
    ],
    generatedAt: "2026-05-18T00:00:00.000Z",
  },
};

const okStoryboard = {
  status: "done" as const,
  jsonPath: "/v/10_media/storyboards/storyboard.json",
  shotCount: 1,
  storyboard: {
    schemaVersion: 1 as const,
    scriptId: "run-media",
    ventureSlug: "test",
    shots: [
      { sceneId: "scene-1", engineHint: "hyperframes" as const, prompt: "p1", durationSec: 6 },
    ],
    generatedAt: "2026-05-18T00:00:00.000Z",
  },
};

const okRender = {
  status: "done" as const,
  rendersDir: "/v/10_media/renders",
  shotCount: 1,
  successCount: 1,
  failureCount: 0,
  pendingFlowCount: 0,
  perShotResults: [
    {
      sceneId: "scene-1",
      status: "rendered" as const,
      engine: "hyperframes" as const,
      path: "/v/10_media/renders/scene-1.mp4",
      durationSec: 6,
    },
  ],
};

const okStitch = {
  status: "done" as const,
  reelPath: "/v/10_media/exports/launch-reel.mp4",
  shotCount: 1,
};

describe("MediaStageRunner deep research adoption", () => {
  it("gathers a media-format-conventions briefing and threads it into the script step", async () => {
    orchestrateTopic.mockClear();
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);

    const fs = new InMemoryFs();
    await fs.writeFile("/v/08_launch/launch-announcement.md", "# Launch announcement\n\nWe are live.");
    const runner = new MediaStageRunner({
      manifest: makeManifest({ industry: "workflow SaaS" }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-media",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/media-format-conventions.md",
        "/v/00_research/deep/briefings/media-format-conventions.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("media deep-research ready");

    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("media-format-conventions");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("workflow SaaS");
    expect(opts.ventureContext).toContain("Launch announcement excerpt");

    expect(scriptSpy).toHaveBeenCalledTimes(1);
    const scriptCtx = scriptSpy.mock.calls[0]?.[0] as {
      deepResearch?: { filename: string; excerpt: string }[];
    };
    expect(scriptCtx.deepResearch).toBeDefined();
    expect(scriptCtx.deepResearch?.[0]?.filename).toBe("media-format-conventions.md");
    expect(scriptCtx.deepResearch?.[0]?.excerpt).toContain("Format conventions");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("media-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic media path when not enabled", async () => {
    orchestrateTopic.mockClear();
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);

    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-media",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    const scriptCtx = scriptSpy.mock.calls[0]?.[0] as {
      deepResearch?: unknown;
    };
    expect(scriptCtx.deepResearch).toBeUndefined();
  });

  it("skips deep research when no callLlm provided", async () => {
    orchestrateTopic.mockClear();
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);

    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      enableDeepResearch: true,
      runId: "run-media",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
