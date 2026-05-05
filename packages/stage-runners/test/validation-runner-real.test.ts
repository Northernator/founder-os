/**
 * ValidationStageRunner -- real-path tests.
 *
 * The runner now wraps createValidationSummaryStep instead of writing
 * a placeholder checkpoint inline. These tests mock the step (so the
 * runner test does not pull in pipeline-runner internals) and exercise:
 *   1. Success path: artifacts indexed, summary log emitted, stage
 *      progress advanced.
 *   2. With LLM caller: the runner forwards callLlm into the step ctx.
 *   3. Without LLM caller: the runner runs the step with no callLlm
 *      and still produces success.
 *   4. Failure path: a thrown step propagates as VALIDATION_STEP_THREW.
 *
 * Mirrors the pattern of ProductStageRunner\'s testing (vi.mock the
 * pipeline-runner steps + InMemoryFs harness).
 *
 * Note: the log-string contract test ("validation checkpoint written")
 * lives in log-strings.test.ts so a single regression breaks both --
 * the helper-parsed message and this real-path coverage stay in sync.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

// Spy that captures the ctx the runner forwards. Each test re-assigns
// the implementation via the spy to control success vs failure.
const stepSpy = vi.fn();

vi.mock("@founder-os/pipeline-runner", () => ({
  createValidationSummaryStep: (ctx: unknown) => stepSpy(ctx),
}));

const { ValidationStageRunner } = await import("../src/runners/validation-runner.js");
const { PipelineOrchestrator } = await import("../src/orchestrator.js");

const STATE = "v/.founder/state";

function defaultStepResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "done",
    jsonPath: "v/02_validation/validation-summary.json",
    mdPath: "v/02_validation/validation-summary.md",
    summary: {
      schemaVersion: 1,
      stage: "VALIDATION",
      runId: "stub-run",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-01-01T00:00:00Z",
      decision: "undecided",
      decisionReason: "",
      icp: { description: "", role: "", pain: "" },
      offer: { valueProposition: "", whatsIncluded: "", whatsExcluded: "" },
      pricing: { pricePoint: "", pricingModel: "" },
      experiments: { total: 0, done: 0, running: 0, planned: 0 },
      keyLearnings: "",
      whatChanged: "",
      musthaves: {
        icpDefined: false,
        offerDefined: false,
        pricingDecided: false,
        experimentRun: false,
        resultsDocumented: false,
        decisionMade: false,
        allMet: false,
      },
      sources: [],
      summarySource: "deterministic",
      ...overrides,
    },
  };
}

describe("ValidationStageRunner.run() (real path)", () => {
  it("indexes both summary artifacts and emits the checkpoint log", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new ValidationStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await orch.runStage(runner, { force: true });

    expect(result.success).toBe(true);
    expect(result.stageName).toBe("VALIDATION");
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "v/02_validation/validation-summary.json",
        "v/02_validation/validation-summary.md",
      ])
    );
    // The literal log message that run-validation-stage.ts:deriveSteps
    // pattern-matches. Pinned by log-strings.test.ts as well.
    expect(result.logs.map((l) => l.message)).toContain("validation checkpoint written");
    // Step spy received the ctx with no callLlm (legacy default path).
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const ctx = stepSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.manifest).toBe(manifest);
    expect(ctx.ventureRoot).toBe("/v");
    expect(ctx.callLlm).toBeUndefined();
  });

  it("forwards callLlm into the step ctx when provided", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult({ summarySource: "llm" }));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const callLlm = async () => "stub";
    const runner = new ValidationStageRunner({
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

  it("runs without callLlm and still succeeds", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new ValidationStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("propagates a thrown step as VALIDATION_STEP_THREW", async () => {
    stepSpy.mockReset();
    stepSpy.mockRejectedValue(new Error("disk full"));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new ValidationStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_STEP_THREW");
    expect(result.error?.message).toBe("disk full");
    expect(result.error?.recoverable).toBe(true);
  });

  it("advances stage-progress on success via the orchestrator", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new ValidationStageRunner({ manifest, ventureRoot: "/v", fs });

    await orch.runStage(runner, { force: true });

    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees write
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("VALIDATION");
  });
});

describe("ValidationStageRunner.validate()", () => {
  it("rejects when manifest.id or manifest.name is empty", async () => {
    const fs = new InMemoryFs();
    const runner = new ValidationStageRunner({
      manifest: makeManifest({ id: "", name: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a complete manifest with no LLM caller", async () => {
    const fs = new InMemoryFs();
    const runner = new ValidationStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});
