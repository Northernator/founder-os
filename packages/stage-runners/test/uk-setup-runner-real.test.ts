import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "uk-setup-compliance",
    topicLabel: "UK setup, tax, and data compliance",
    questions: [
      {
        id: "q-uk-companies-house",
        question: "What current Companies House obligations apply?",
        angle: "regulatory",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Companies House baseline",
        body: "Founders should confirm incorporation, PSC, registered-office, and confirmation statement obligations.",
        sources: ["https://www.gov.uk/limited-company-formation"],
      },
    ],
    sources: [
      {
        url: "https://www.gov.uk/limited-company-formation",
        title: "Set up a limited company",
        publisher: "GOV.UK",
        accessedAt: "2026-05-18T00:00:00.000Z",
        retrievedBy: "claude-sub",
        trustTier: "primary",
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
  plan: {
    questions: [],
    fallbackIndex: 0,
  },
  transcripts: {
    planner: null,
    crossReference: null,
    synthesiser: null,
    workers: {
      outcomes: [],
      successes: new Map(),
      failures: new Map(),
    },
  },
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { UkSetupStageRunner } = await import("../src/runners/uk-setup-runner.js");

describe("UkSetupStageRunner.run() deep research adoption", () => {
  it("gathers a UK compliance briefing when callLlm is provided and indexes it", async () => {
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder will sell B2B SaaS in the UK and handle personal data.");
    const manifest = makeManifest({
      handlesPersonalData: true,
      takesPayments: true,
      hiresStaff: true,
    });
    const callLlm = async () => "stub";
    const runner = new UkSetupStageRunner({
      manifest,
      ventureRoot: "/v",
      fs,
      callLlm,
      runId: "run-uk",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/uk-setup-compliance.md",
        "/v/00_research/deep/briefings/uk-setup-compliance.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("uk-setup deep-research ready");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("uk-setup-compliance");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("Handles personal data: true");
    expect(opts.ventureContext).toContain("Founder will sell B2B SaaS");
    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("uk-setup-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic canvas-only path when no callLlm is provided", async () => {
    orchestrateTopic.mockClear();
    const fs = new InMemoryFs();
    const runner = new UkSetupStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "run-uk",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    expect(result.artifactsCreated).not.toContain("/v/00_research/deep/briefings/uk-setup-compliance.md");
  });
});
