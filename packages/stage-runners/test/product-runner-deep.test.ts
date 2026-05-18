import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const briefSpy = vi.fn(async () => ({ status: "done" }));
const specSpy = vi.fn(async () => ({ status: "done" }));
const screensSpy = vi.fn(async () => ({ status: "done" }));

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "product-ux-baseline",
    topicLabel: "Product UX patterns and technical baseline",
    questions: [
      {
        id: "q-product-ux-patterns",
        question: "What best-in-class UX patterns are current?",
        angle: "technical",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "UX baseline",
        body: "Best-in-class SaaS tools keep onboarding task-focused and expose empty states with clear next actions.",
        sources: ["https://example.com/ux"],
      },
    ],
    sources: [
      {
        url: "https://example.com/ux",
        title: "UX patterns",
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
    staleAfterDays: 90,
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
  ensureBriefStep: (ctx: unknown) => briefSpy(ctx),
  ensureSpecStep: (ctx: unknown) => specSpy(ctx),
  ensureScreensStep: (ctx: unknown) => screensSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { ProductStageRunner } = await import("../src/runners/product-runner.js");

describe("ProductStageRunner deep research adoption", () => {
  it("gathers and indexes a product UX baseline when enabled", async () => {
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder wants a workflow SaaS product.");
    const runner = new ProductStageRunner({
      manifest: makeManifest({ industry: "workflow software" }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-product",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/product-ux-baseline.md",
        "/v/00_research/deep/briefings/product-ux-baseline.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("product deep-research ready");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("product-ux-baseline");
    expect(opts.staleAfterDays).toBe(90);
    expect(opts.ventureContext).toContain("workflow SaaS");
    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("product-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic product path when not enabled", async () => {
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    const runner = new ProductStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-product",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
