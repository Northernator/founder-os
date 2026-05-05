/**
 * FinanceStageRunner -- real-path tests.
 *
 * The runner now wraps createFinancePlanStep instead of writing a
 * placeholder canvas inline. These tests mock the step (so the
 * runner test does not pull in pipeline-runner internals) and exercise:
 *   1. Success path: 3 artifacts indexed (canvas + plan.json + plan.md),
 *      "ensure-finance-canvas finished" log emitted, stage progress
 *      advanced.
 *   2. With LLM caller: the runner forwards callLlm into the step ctx.
 *   3. Without LLM caller: still succeeds.
 *   4. Failure path: thrown step propagates as FINANCE_STEP_THREW.
 *   5. Canvas-status passthrough: log payload reflects step result\'s
 *      canvasStatus ("scaffolded" vs "preserved").
 *
 * Mirrors validation-runner-real.test.ts + wireframe-runner-real.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const stepSpy = vi.fn();

vi.mock("@founder-os/pipeline-runner", () => ({
  createFinancePlanStep: (ctx: unknown) => stepSpy(ctx),
}));

const { FinanceStageRunner } = await import("../src/runners/finance-runner.js");
const { PipelineOrchestrator } = await import("../src/orchestrator.js");

const STATE = "v/.founder/state";

function defaultStepResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "done",
    canvasStatus: "scaffolded",
    canvasPath: "v/05_finance/finance-canvas.json",
    planJsonPath: "v/05_finance/finance-plan.json",
    planMdPath: "v/05_finance/finance-plan.md",
    canvas: {
      schemaVersion: 1,
      stage: "FINANCE",
      status: "checkpoint",
      runId: "stub",
      ventureId: "test-venture",
      createdAt: "2026-01-01T00:00:00Z",
      monthlyBudgetCapGBP: null,
      startingCapitalGBP: null,
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
      createdAt: "2026-01-01T00:00:00Z",
      inputs: {
        monthlyBudgetCapGBP: null,
        startingCapitalGBP: null,
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
      assumptions: [],
      sources: ["finance-canvas.json"],
      generationSource: "deterministic",
      ...overrides,
    },
  };
}

describe("FinanceStageRunner.run() (real path)", () => {
  it("indexes canvas + plan.json + plan.md and emits the canvas log", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new FinanceStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await orch.runStage(runner, { force: true });

    expect(result.success).toBe(true);
    expect(result.stageName).toBe("FINANCE");
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "v/05_finance/finance-canvas.json",
        "v/05_finance/finance-plan.json",
        "v/05_finance/finance-plan.md",
      ])
    );
    // The literal log message that run-finance-stage.ts:deriveSteps
    // pattern-matches. Pinned by log-strings.test.ts as well -- BOTH
    // new-write and skip-if-exists paths must continue to emit it.
    expect(result.logs.map((l) => l.message)).toContain("ensure-finance-canvas finished");
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const ctx = stepSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.manifest).toBe(manifest);
    expect(ctx.ventureRoot).toBe("/v");
    expect(ctx.callLlm).toBeUndefined();
  });

  it("forwards callLlm into the step ctx when provided", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const callLlm = async () => "stub";
    const runner = new FinanceStageRunner({
      manifest,
      ventureRoot: "/v",
      fs,
      callLlm,
    });

    const result = await runner.run();
    expect(result.success).toBe(true);
    const ctx = stepSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.callLlm).toBe(callLlm);
  });

  it("preserves the canvas on the skip-if-exists path", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult({ canvasStatus: "preserved" }));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new FinanceStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(true);
    // canvasStatus is surfaced in the log payload.
    const canvasLog = result.logs.find((l) => l.message === "ensure-finance-canvas finished");
    expect(canvasLog).toBeDefined();
    expect((canvasLog?.data as Record<string, unknown> | undefined)?.canvasStatus).toBe(
      "preserved"
    );
  });

  it("propagates a thrown step as FINANCE_STEP_THREW", async () => {
    stepSpy.mockReset();
    stepSpy.mockRejectedValue(new Error("disk full"));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new FinanceStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FINANCE_STEP_THREW");
    expect(result.error?.message).toBe("disk full");
    expect(result.error?.recoverable).toBe(true);
  });

  it("advances stage-progress on success via the orchestrator", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new FinanceStageRunner({ manifest, ventureRoot: "/v", fs });

    await orch.runStage(runner, { force: true });

    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees write
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("FINANCE");
  });
});

describe("FinanceStageRunner.validate()", () => {
  it("rejects when manifest.id is empty", async () => {
    const fs = new InMemoryFs();
    const runner = new FinanceStageRunner({
      manifest: makeManifest({ id: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts a complete manifest", async () => {
    const fs = new InMemoryFs();
    const runner = new FinanceStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});
