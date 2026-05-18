import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const auditStepSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "audit-current-state-advisory",
    topicLabel: "OWASP Top-10, WCAG 2.2, and UK ICO current-state advisory",
    questions: [
      {
        id: "q-audit-owasp-top-10",
        question: "Current OWASP Top-10?",
        angle: "risk",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "OWASP Top-10 current state",
        body: "The current top-cited mitigations centre on injection, broken access control, and crypto failures.",
        sources: ["https://example.com/owasp"],
      },
    ],
    sources: [
      {
        url: "https://example.com/owasp",
        title: "OWASP Top-10",
        publisher: "OWASP",
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
  plan: { questions: [], fallbackIndex: 0 },
  transcripts: {
    planner: null,
    crossReference: null,
    synthesiser: null,
    workers: { outcomes: [], successes: new Map(), failures: new Map() },
  },
}));

vi.mock("@founder-os/pipeline-runner", () => ({
  auditVentureStep: (ctx: unknown) => auditStepSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { AuditStageRunner } = await import("../src/runners/audit-runner.js");

function cleanAuditResult(): Record<string, unknown> {
  return {
    status: "done",
    findings: [],
    skippedForStage: [],
  };
}

function auditWithBlocker(): Record<string, unknown> {
  return {
    status: "done",
    findings: [
      {
        ruleId: "test.blocker",
        severity: "high",
        title: "Synthetic blocker",
        message: "synthetic high finding for test",
      },
    ],
    skippedForStage: [],
  };
}

describe("AuditStageRunner deep research adoption", () => {
  it("gathers and indexes a current-state advisory when enabled and audit passes", async () => {
    orchestrateTopic.mockClear();
    auditStepSpy.mockReset();
    auditStepSpy.mockResolvedValue(cleanAuditResult());

    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder building a UK SaaS handling personal data for SMEs.");
    const runner = new AuditStageRunner({
      manifest: makeManifest({ handlesPersonalData: true, regulated: false }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-audit",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/audit-current-state-advisory.md",
        "/v/00_research/deep/briefings/audit-current-state-advisory.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("audit deep-research ready");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("audit-current-state-advisory");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("handlesPersonalData=true");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("audit-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic audit path when not enabled", async () => {
    orchestrateTopic.mockClear();
    auditStepSpy.mockReset();
    auditStepSpy.mockResolvedValue(cleanAuditResult());

    const fs = new InMemoryFs();
    const runner = new AuditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-audit",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });

  it("skips deep research when no callLlm provided, still succeeds deterministically", async () => {
    orchestrateTopic.mockClear();
    auditStepSpy.mockReset();
    auditStepSpy.mockResolvedValue(cleanAuditResult());

    const fs = new InMemoryFs();
    const runner = new AuditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      enableDeepResearch: true,
      runId: "run-audit",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });

  it("still indexes deep research artifacts on the blocker path", async () => {
    orchestrateTopic.mockClear();
    auditStepSpy.mockReset();
    auditStepSpy.mockResolvedValue(auditWithBlocker());

    const fs = new InMemoryFs();
    const runner = new AuditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-audit",
    });

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("AUDIT_HAS_BLOCKERS");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/audit-current-state-advisory.md",
      ])
    );
  });
});
