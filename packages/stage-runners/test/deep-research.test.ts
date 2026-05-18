import { describe, expect, it, vi } from "vitest";
import type { ResearchBriefing, ResearchProvider } from "@founder-os/research-deep-core";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const briefing: ResearchBriefing = {
  ventureSlug: "test",
  topicSlug: "customer-problems",
  topicLabel: "Customer problems",
  questions: [
    {
      id: "q1",
      question: "Who has the pain?",
      angle: "customer",
      priority: "must",
    },
  ],
  sections: [
    {
      heading: "Buyer pain",
      body: "Teams lose time reconciling fragmented workflow notes.",
      sources: ["https://example.com/report"],
    },
  ],
  sources: [
    {
      url: "https://example.com/report",
      title: "Report",
      publisher: "Example",
      accessedAt: "2026-05-18T00:00:00.000Z",
      retrievedBy: "claude-sub",
      trustTier: "secondary",
    },
  ],
  channelsUsed: ["claude-sub", "gemini-sub"],
  crossReferencedBy: ["claude-sub"],
  synthesisedBy: "claude-sub",
  disagreements: [],
  unanswered: [],
  generatedAt: "2026-05-18T00:00:00.000Z",
  staleAfterDays: 30,
};

const orchestrateTopic = vi.fn(async (opts: { onProgress?: (event: { phase: string; topicSlug: string }) => void }) => {
  opts.onProgress?.({ phase: "planner-start", topicSlug: "customer-problems" });
  return {
    briefing,
    plan: { questions: briefing.questions, fallbackIndex: 0 },
    transcripts: {
      planner: { raw: "planner" },
      crossReference: { raw: "cross" },
      synthesiser: { raw: "synth" },
      workers: {
        outcomes: [],
        successes: new Map([["claude-sub", { sections: [], sources: [], unanswered: [], rawTranscript: { raw: "worker" } }]]),
        failures: new Map(),
      },
    },
  };
});

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const noopLlm = async () => "{}";
const workers: ResearchProvider[] = [];

describe("gatherDeepResearch()", () => {
  it("runs orchestrator and writes briefing, plan, sources, and transcripts", async () => {
    const { gatherDeepResearch, getDeepResearchBriefingMarkdownPath, getDeepResearchPlanPath } = await import(
      "../src/deep-research.js"
    );
    const fs = new InMemoryFs();

    const result = await gatherDeepResearch({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      topic: { slug: "customer-problems", label: "Customer problems" },
      questions: briefing.questions,
      ventureContext: "Founder intake",
      callLlm: noopLlm,
      workers,
      now: "2026-05-18T00:00:00.000Z",
      runId: "run-1",
    });

    expect(result.fromCache).toBe(false);
    expect(fs.files.has(getDeepResearchBriefingMarkdownPath("/v", "customer-problems"))).toBe(true);
    expect(fs.files.get(getDeepResearchPlanPath("/v"))).toContain('"status": "ready"');
    expect(result.artifactsCreated.some((p) => p.includes("/transcripts/claude-sub/customer-problems-run-1.json"))).toBe(
      true
    );
  });

  it("returns a fresh cached briefing without calling orchestrator", async () => {
    const { gatherDeepResearch, getDeepResearchBriefingJsonPath } = await import("../src/deep-research.js");
    const fs = new InMemoryFs();
    await fs.writeFile(getDeepResearchBriefingJsonPath("/v", "customer-problems"), `${JSON.stringify(briefing)}\n`);
    orchestrateTopic.mockClear();

    const result = await gatherDeepResearch({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      topic: { slug: "customer-problems", label: "Customer problems" },
      questions: briefing.questions,
      ventureContext: "Founder intake",
      callLlm: noopLlm,
      workers,
      now: "2026-05-19T00:00:00.000Z",
    });

    expect(result.fromCache).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });

  it("blocks runs that exceed maxCostGBP", async () => {
    const { DeepResearchCostCapError, gatherDeepResearch } = await import("../src/deep-research.js");
    const fs = new InMemoryFs();

    await expect(
      gatherDeepResearch({
        manifest: makeManifest(),
        ventureRoot: "/v",
        fs,
        topic: { slug: "customer-problems", label: "Customer problems" },
        questions: briefing.questions,
        ventureContext: "Founder intake",
        callLlm: noopLlm,
        workers,
        maxCostGBP: 0.1,
        projectedCostGBP: 0.5,
      })
    ).rejects.toBeInstanceOf(DeepResearchCostCapError);
  });

  it("filesystem paste-in callback writes prompts and consumes response.md on rerun", async () => {
    const {
      gatherDeepResearch,
      getDeepResearchPasteInPromptPath,
      getDeepResearchPasteInResponsePath,
      getDeepResearchPasteInStatusPath,
    } = await import("../src/deep-research.js");
    const fs = new InMemoryFs();
    orchestrateTopic.mockClear();

    await gatherDeepResearch({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      topic: { slug: "customer-problems", label: "Customer problems" },
      questions: briefing.questions,
      ventureContext: "Founder intake",
      callLlm: noopLlm,
      now: "2026-05-18T00:00:00.000Z",
    });

    const firstOpts = orchestrateTopic.mock.calls[0][0] as { workers: ResearchProvider[] };
    const chatgpt = firstOpts.workers.find((w) => w.name === "chatgpt-sub");
    expect(chatgpt).toBeDefined();
    const skipped = await chatgpt!.researchTopic({
      topic: { slug: "customer-problems", label: "Customer problems" },
      questions: briefing.questions,
      ventureContext: "Founder intake",
      accessedAt: "2026-05-18T00:00:00.000Z",
    });

    const promptPath = getDeepResearchPasteInPromptPath("/v", "chatgpt-sub", "customer-problems");
    const responsePath = getDeepResearchPasteInResponsePath("/v", "chatgpt-sub", "customer-problems");
    const statusPath = getDeepResearchPasteInStatusPath("/v", "chatgpt-sub", "customer-problems");
    expect(skipped.unanswered).toEqual(["Who has the pain?"]);
    expect(fs.files.get(promptPath)).toContain("# Topic: Customer problems");
    expect(fs.files.get(statusPath)).toContain('"status": "pending"');

    await fs.writeFile(
      responsePath,
      `## Buyer pain

Teams lose time reconciling fragmented workflow notes.

**Sources consulted:**
- Report, Example, accessed 2026-05-18 — https://example.com/report
`
    );

    const pasted = await chatgpt!.researchTopic({
      topic: { slug: "customer-problems", label: "Customer problems" },
      questions: briefing.questions,
      ventureContext: "Founder intake",
      accessedAt: "2026-05-18T00:00:00.000Z",
    });

    expect(pasted.sections[0]?.heading).toBe("Buyer pain");
    expect(fs.files.get(statusPath)).toContain('"status": "pasted"');
  });
});

describe("DeepResearchStageRunner", () => {
  it("warm-up writes a checkpoint and returns artifacts", async () => {
    const { DeepResearchStageRunner, getDeepResearchCheckpointPath } = await import("../src/deep-research.js");
    const fs = new InMemoryFs();
    const runner = new DeepResearchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      intake: "Founder intake",
      callLlm: noopLlm,
      workers,
      runId: "run-1",
      topicSeeds: [
        {
          slug: "customer-problems",
          label: "Customer problems",
          questions: briefing.questions,
        },
      ],
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(fs.files.has(getDeepResearchCheckpointPath("/v"))).toBe(true);
    expect(result.logs.map((l) => l.message)).toContain("deep-research warm-up finished");
  });

  it("warm-up fails before any topic when projected cost exceeds cap", async () => {
    const { DeepResearchStageRunner } = await import("../src/deep-research.js");
    const fs = new InMemoryFs();
    orchestrateTopic.mockClear();
    const runner = new DeepResearchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      intake: "Founder intake",
      callLlm: noopLlm,
      workers,
      maxCostGBPPerWarmUp: 0.1,
      estimatedCostGBPPerTopic: 0.5,
      topicSeeds: [
        {
          slug: "customer-problems",
          label: "Customer problems",
          questions: briefing.questions,
        },
      ],
    });

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DEEP_RESEARCH_COST_CAP");
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
