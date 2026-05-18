import { describe, expect, it, vi } from "vitest";
import { getBrandKitDir, getHandoffPackDir } from "@founder-os/workspace-core";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const orchestratorSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "handoff-pack-investor-handoff-current-state",
    topicLabel: "Investor due-diligence + operational handoff current-state advisory",
    questions: [
      {
        id: "q-handoff-investor-due-diligence",
        question: "Current investor due-diligence expectations?",
        angle: "financial",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Investor data room baseline",
        body: "Pre-seed UK SaaS data rooms typically include cap table, financial model, customer references, and a 12-18mo plan.",
        sources: ["https://example.com/data-room"],
      },
    ],
    sources: [
      {
        url: "https://example.com/data-room",
        title: "Data room baseline",
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

vi.mock("@founder-os/handoff-pack-providers/node", () => ({
  renderHandoffPackArtefactsStep: (opts: unknown) => orchestratorSpy(opts),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { HandoffPackStageRunner } = await import("../src/runners/handoff-pack-runner.js");

const VENTURE = "/v";

function brandShipped(fs: InMemoryFs): void {
  fs.files.set(`${getBrandKitDir(VENTURE)}/brand-brief.json`, "{}");
}

function fakeArtefacts() {
  return {
    brand: {
      brandDir: `${getHandoffPackDir(VENTURE)}/.brand`,
      tokens: {} as unknown,
      config: {} as unknown,
      logoCopied: false,
      notes: ["brand: stubbed"],
    },
    inventory: {
      generatedAt: "2026-05-18T00:00:00.000Z",
      ventureSlug: "test",
      ventureName: "Test Venture",
      totalDocs: 1,
      entries: [
        {
          docId: "g0",
          category: "00-company-control" as const,
          slot: "00",
          title: "Doc",
          tier: "A" as const,
          status: "generated" as const,
          pdfRelativePath: "company-control/g0.pdf",
          lastRenderedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
      rolePacks: {},
    },
    inventoryMarkdown: "# inventory\n",
    walk: {
      entries: [],
      counts: { generated: 1, partial: 0, stub: 0, manual: 0, failed: 0, pending: 0 },
      notes: [],
    },
    notes: [],
    rolePacks: {
      rolePacks: {},
      results: [],
      counts: { generated: 0, skipped: 8, failed: 0 },
      notes: [],
    },
  };
}

describe("HandoffPackStageRunner deep research adoption", () => {
  it("gathers a cross-cutting briefing and indexes it when enabled", async () => {
    orchestrateTopic.mockClear();
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts());

    const fs = new InMemoryFs();
    brandShipped(fs);
    await fs.writeFile("/v/00_research/intake.md", "Founder building UK SaaS for fintech SMEs.");

    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({ industry: "fintech", takesPayments: true }),
      ventureRoot: VENTURE,
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-handoff",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/handoff-pack-investor-handoff-current-state.md",
        "/v/00_research/deep/briefings/handoff-pack-investor-handoff-current-state.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("handoff-pack deep-research ready");

    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("handoff-pack-investor-handoff-current-state");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("fintech");
    expect(opts.ventureContext).toContain("takesPayments=true");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("handoff-pack-deep-research"),
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic handoff-pack path when not enabled", async () => {
    orchestrateTopic.mockClear();
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts());

    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
      callLlm: async () => "stub",
      runId: "run-handoff",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });

  it("skips deep research when no callLlm provided, still succeeds deterministically", async () => {
    orchestrateTopic.mockClear();
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts());

    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
      enableDeepResearch: true,
      runId: "run-handoff",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });

  it("attaches the briefing markdown to the review gate when one is configured", async () => {
    orchestrateTopic.mockClear();
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts());

    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({
        pipeline: { reviewGates: ["HANDOFF_PACK"] },
      }),
      ventureRoot: VENTURE,
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-handoff",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.reviewGateId).toBeDefined();
    const gatesFile = Array.from(fs.files.entries()).find(([path]) =>
      path.endsWith("review-gates.jsonl") || path.endsWith("review-gates.json"),
    );
    expect(gatesFile).toBeDefined();
    expect(gatesFile?.[1] ?? "").toContain("handoff-pack-deep-research");
  });
});
