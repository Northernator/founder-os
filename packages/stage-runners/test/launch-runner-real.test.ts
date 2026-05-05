/**
 * LaunchStageRunner -- real-path tests.
 *
 * The runner now wraps createLaunchPackageStep instead of writing a
 * placeholder receipt inline. These tests mock the step (so the
 * runner test does not pull in pipeline-runner internals) and exercise:
 *   1. Success path: 2 artifacts indexed (receipt + announcement),
 *      "launch receipt written" log emitted, stage progress advanced.
 *   2. With LLM caller: the runner forwards callLlm into the step ctx.
 *   3. Without LLM caller: still succeeds.
 *   4. Failure path: thrown step propagates as LAUNCH_STEP_THREW.
 *   5. Receipt status passthrough: log payload reflects step\'s
 *      receiptStatus ("ready-to-launch" / "checkpoint" /
 *      "needs-attention").
 *
 * Mirrors validation/wireframe/finance real-path tests.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const stepSpy = vi.fn();

vi.mock("@founder-os/pipeline-runner", () => ({
  createLaunchPackageStep: (ctx: unknown) => stepSpy(ctx),
}));

const { LaunchStageRunner } = await import("../src/runners/launch-runner.js");
const { PipelineOrchestrator } = await import("../src/orchestrator.js");

const STATE = "v/.founder/state";

function defaultStepResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "done",
    receiptPath: "v/08_launch/launch-receipt.json",
    announcementPath: "v/08_launch/launch-announcement.md",
    receipt: {
      schemaVersion: 1,
      stage: "LAUNCH",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      ventureSlug: "test",
      launchedAt: "2026-01-01T00:00:00Z",
      status: "checkpoint",
      deploymentUrl: null,
      versionTag: null,
      buildRunId: null,
      brand: { name: null, tagline: null, targetAudience: null },
      validation: { decision: null, icp: null },
      pricing: { pricePoint: null, pricingModel: null, fundingRecommendation: null },
      ukSetup: { entityType: "ltd", hasUkSetupCanvas: false },
      build: { hasHandoff: false },
      preLaunchChecklist: [],
      sources: [],
      generationSource: "deterministic",
      ...overrides,
    },
  };
}

describe("LaunchStageRunner.run() (real path)", () => {
  it("indexes receipt + announcement and emits the launch log", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest({ id: "v123", name: "Acme", slug: "acme" });
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new LaunchStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await orch.runStage(runner, { force: true });

    expect(result.success).toBe(true);
    expect(result.stageName).toBe("LAUNCH");
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "v/08_launch/launch-receipt.json",
        "v/08_launch/launch-announcement.md",
      ])
    );
    // Pinned literal that run-launch-stage.ts:deriveSteps + log-strings.test.ts
    // both depend on.
    expect(result.logs.map((l) => l.message)).toContain("launch receipt written");
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
    const runner = new LaunchStageRunner({
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
    const runner = new LaunchStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("propagates a thrown step as LAUNCH_STEP_THREW", async () => {
    stepSpy.mockReset();
    stepSpy.mockRejectedValue(new Error("disk full"));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new LaunchStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("LAUNCH_STEP_THREW");
    expect(result.error?.message).toBe("disk full");
    expect(result.error?.recoverable).toBe(true);
  });

  it("surfaces receipt status in the launch log payload", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult({ status: "ready-to-launch" }));
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const runner = new LaunchStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    const launchLog = result.logs.find((l) => l.message === "launch receipt written");
    expect(launchLog).toBeDefined();
    expect((launchLog?.data as Record<string, unknown> | undefined)?.receiptStatus).toBe(
      "ready-to-launch"
    );
  });

  it("advances stage-progress on success via the orchestrator", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = new InMemoryFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new LaunchStageRunner({ manifest, ventureRoot: "/v", fs });

    await orch.runStage(runner, { force: true });

    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees write
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("LAUNCH");
  });
});

describe("LaunchStageRunner.validate()", () => {
  it("rejects when manifest.id or manifest.name is empty", async () => {
    const fs = new InMemoryFs();
    const runner = new LaunchStageRunner({
      manifest: makeManifest({ id: "", name: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a complete manifest", async () => {
    const fs = new InMemoryFs();
    const runner = new LaunchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});
