import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const financeStepSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "finance-uk-saas-benchmarks",
    topicLabel: "UK SaaS finance benchmarks and tax/VAT eligibility",
    questions: [
      {
        id: "q-finance-uk-saas-benchmarks",
        question: "UK SaaS benchmark costs?",
        angle: "financial",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Benchmark costs",
        body: "Typical early-stage UK SaaS hosting + payroll + accountant lines land around GBP 1,200/month at the founder-only stage.",
        sources: ["https://example.com/uk-saas-benchmarks"],
      },
    ],
    sources: [
      {
        url: "https://example.com/uk-saas-benchmarks",
        title: "UK SaaS benchmarks",
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
  createFinancePlanStep: (ctx: unknown) => financeStepSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { FinanceStageRunner } = await import("../src/runners/finance-runner.js");

function defaultStepResult(): Record<string, unknown> {
  return {
    status: "done",
    canvasStatus: "scaffolded",
    canvasPath: "/v/05_finance/finance-canvas.json",
    planJsonPath: "/v/05_finance/finance-plan.json",
    planMdPath: "/v/05_finance/finance-plan.md",
    canvas: {
      schemaVersion: 1,
      stage: "FINANCE",
      status: "checkpoint",
      runId: "stub",
      ventureId: "test-venture",
      createdAt: "2026-05-18T00:00:00.000Z",
      monthlyBudgetCapGBP: null,
      startingCapitalGBP: null,
      backendHostingMonthlyUsdCap: 0,
      revenueModel: null,
      pricingTiers: [],
      costProjections: null,
      runwayMonths: null,
      note: "stub",
    },
    plan: {
      schemaVersion: 1,
      stage: "FINANCE",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-05-18T00:00:00.000Z",
      inputs: {
        monthlyBudgetCapGBP: null,
        startingCapitalGBP: null,
        backendHostingMonthlyUsdCap: 0,
        entityType: "ltd",
        takesPayments: false,
        regulated: false,
        handlesPersonalData: false,
        hiresStaff: false,
        pricePoint: null,
        pricingModel: null,
        validationDecision: null,
      },
      monthlyCosts: {
        infrastructureGBP: 100,
        paymentProcessingGBP: 0,
        complianceGBP: 0,
        staffingGBP: 0,
        otherGBP: 0,
        totalGBP: 100,
      },
      revenueAssumption: {
        monthlyPricePerCustomerGBP: null,
        targetCustomers12m: 50,
        projectedMrr12mGBP: null,
        rampMonths: 6,
      },
      runway: { months: null, breakEvenCustomers: null },
      fundingRecommendation: { path: "unclear", rationale: "stub" },
      backendHosting: {
        resolvedEngine: null,
        estimatedMonthlyUsd: 0,
        capMonthlyUsd: 0,
        status: "no-backend-yet",
      },
      assumptions: [],
      sources: ["finance-canvas.json"],
      generationSource: "deterministic",
    },
  };
}

describe("FinanceStageRunner deep research adoption", () => {
  it("gathers and indexes a finance benchmark briefing when enabled", async () => {
    orchestrateTopic.mockClear();
    financeStepSpy.mockReset();
    financeStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    await fs.writeFile("/v/00_research/intake.md", "Founder wants a UK SaaS product targeting accountancy firms.");
    const runner = new FinanceStageRunner({
      manifest: makeManifest({ industry: "accountancy software", monthlyBudgetCapGBP: 1500 }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub narrative",
      enableDeepResearch: true,
      runId: "run-finance",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/finance-uk-saas-benchmarks.md",
        "/v/00_research/deep/briefings/finance-uk-saas-benchmarks.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("finance deep-research ready");
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("finance-uk-saas-benchmarks");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("accountancy software");
    expect(opts.ventureContext).toContain("Monthly budget cap: GBP 1500");

    expect(financeStepSpy).toHaveBeenCalledTimes(1);
    const stepCtx = financeStepSpy.mock.calls[0]?.[0] as {
      deepResearch?: { filename: string; excerpt: string }[];
    };
    expect(stepCtx.deepResearch).toBeDefined();
    expect(stepCtx.deepResearch?.[0]?.filename).toBe("finance-uk-saas-benchmarks.md");
    expect(stepCtx.deepResearch?.[0]?.excerpt).toContain("Benchmark costs");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("finance-deep-research")
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic finance path when not enabled", async () => {
    orchestrateTopic.mockClear();
    financeStepSpy.mockReset();
    financeStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    const runner = new FinanceStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-finance",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    const stepCtx = financeStepSpy.mock.calls[0]?.[0] as {
      deepResearch?: unknown;
    };
    expect(stepCtx.deepResearch).toBeUndefined();
  });

  it("skips deep research when no callLlm is provided, still succeeds deterministically", async () => {
    orchestrateTopic.mockClear();
    financeStepSpy.mockReset();
    financeStepSpy.mockResolvedValue(defaultStepResult());

    const fs = new InMemoryFs();
    const runner = new FinanceStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      enableDeepResearch: true,
      runId: "run-finance",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
