import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const namingSpy = vi.fn(async (ctx: { seedHints?: string }) => ({
  status: "done",
  scanPath: "/v/03_brand/names/name-candidates.json",
  added: [{ name: "Lumencore" }],
  total: 1,
  note: ctx.seedHints ?? "",
}));
const briefSpy = vi.fn(async () => ({
  status: "done",
  producedArtifactIds: [],
  brief: { name: "Lumencore", tagline: "Workflows without drag" },
}));
const logoSpy = vi.fn(async () => ({
  status: "done",
  producedArtifactIds: [],
}));

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "brand-positioning-and-naming",
    topicLabel: "Brand positioning and naming collision risk",
    questions: [
      {
        id: "q-brand-positioning-landscape",
        question: "What positioning patterns are common?",
        angle: "competitor",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Positioning landscape",
        body: "Workflow SaaS brands overuse generic promises around productivity and simplicity.",
        sources: ["https://example.com/brand"],
      },
    ],
    sources: [
      {
        url: "https://example.com/brand",
        title: "Brand landscape",
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
    staleAfterDays: 30,
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
  generateNamingCandidatesStep: (ctx: unknown) => namingSpy(ctx),
  createBrandBriefStep: (ctx: unknown) => briefSpy(ctx),
  createLogoPackStep: (ctx: unknown) => logoSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { BrandStageRunner } = await import("../src/runners/brand-runner.js");

describe("BrandStageRunner deep research adoption", () => {
  it("gathers positioning research, injects it into naming hints, and indexes briefing artifacts", async () => {
    namingSpy.mockClear();
    briefSpy.mockClear();
    logoSpy.mockClear();
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder wants a crisp B2B workflow SaaS brand.");
    const runner = new BrandStageRunner({
      manifest: makeManifest({ name: "Lumencore", slug: "lumencore", industry: "workflow software" }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      seedHints: "Avoid names that sound like fintech.",
      enableDeepResearch: true,
      runId: "run-brand",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/brand-positioning-and-naming.md",
        "/v/00_research/deep/briefings/brand-positioning-and-naming.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("brand deep-research ready");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const namingCtx = namingSpy.mock.calls[0]?.[0] as { seedHints?: string };
    expect(namingCtx.seedHints).toContain("Avoid names that sound like fintech.");
    expect(namingCtx.seedHints).toContain("Deep research context for naming");
    expect(namingCtx.seedHints).toContain("Positioning landscape");
    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("brand-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps legacy brand flow when deep research is not enabled", async () => {
    namingSpy.mockClear();
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    const runner = new BrandStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-brand",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    expect(result.artifactsCreated).not.toContain("/v/00_research/deep/briefings/brand-positioning-and-naming.md");
  });
});
