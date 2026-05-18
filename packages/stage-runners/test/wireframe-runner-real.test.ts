/**
 * WireframeStageRunner -- real-path tests.
 *
 * The runner now wraps createWireframesStep instead of writing a
 * placeholder checkpoint inline. These tests mock the step (so the
 * runner test does not pull in pipeline-runner internals) and exercise:
 *   1. Success path: artifacts indexed, summary log emitted, stage
 *      progress advanced.
 *   2. With LLM caller: the runner forwards callLlm into the step ctx.
 *   3. Without LLM caller: the runner runs the step with no callLlm
 *      and still produces success.
 *   4. Failure path: a thrown step propagates as WIREFRAME_STEP_THREW.
 *   5. validate() prereq guard: missing screens-canvas surfaces a
 *      missing-resource error before run() is called.
 *
 * Mirrors the pattern of validation-runner-real.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const stepSpy = vi.fn();
const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "wireframe-screen-patterns",
    topicLabel: "Wireframe screen-pattern conventions",
    questions: [
      {
        id: "q-wireframe-screen-patterns",
        question: "What current screen-pattern conventions are best-in-class?",
        angle: "technical",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Screen patterns",
        body: "Dense B2B tools should prioritise scannable layouts, fast empty states, and predictable task flows.",
        sources: ["https://example.com/wireframes"],
      },
    ],
    sources: [
      {
        url: "https://example.com/wireframes",
        title: "Wireframe patterns",
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
  createWireframesStep: (ctx: unknown) => stepSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { WireframeStageRunner } = await import("../src/runners/wireframe-runner.js");
const { PipelineOrchestrator } = await import("../src/orchestrator.js");

const STATE = "v/.founder/state";
const SCREENS_CANVAS = "v/06_product/wireframes/screens-canvas.json";

function defaultStepResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "done",
    jsonPath: "v/06_product/wireframes/wireframe-checkpoint.json",
    mdPath: "v/06_product/wireframes/wireframes.md",
    checkpoint: {
      schemaVersion: 1,
      stage: "WIREFRAME",
      runId: "stub-run",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-01-01T00:00:00Z",
      derivedFrom: SCREENS_CANVAS,
      screens: [],
      summary: { totalScreens: 0, shellTypeCounts: {} },
      sources: ["screens-canvas.json"],
      generationSource: "deterministic",
      ...overrides,
    },
  };
}

function setupFs(): InMemoryFs {
  const fs = new InMemoryFs();
  // validate() requires the screens canvas to exist.
  fs.files.set(SCREENS_CANVAS, "{}");
  return fs;
}

describe("WireframeStageRunner.run() (real path)", () => {
  it("indexes both wireframe artifacts and emits the checkpoint log", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = setupFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new WireframeStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await orch.runStage(runner, { force: true });

    expect(result.success).toBe(true);
    expect(result.stageName).toBe("WIREFRAME");
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "v/06_product/wireframes/wireframe-checkpoint.json",
        "v/06_product/wireframes/wireframes.md",
      ])
    );
    // The literal log message that run-wireframe-stage.ts:deriveSteps
    // pattern-matches. Pinned by log-strings.test.ts as well.
    expect(result.logs.map((l) => l.message)).toContain("wireframe checkpoint written");
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const ctx = stepSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.manifest).toBe(manifest);
    expect(ctx.ventureRoot).toBe("/v");
    expect(ctx.callLlm).toBeUndefined();
  });

  it("forwards callLlm into the step ctx when provided", async () => {
    stepSpy.mockReset();
    orchestrateTopic.mockClear();
    stepSpy.mockResolvedValue(defaultStepResult({ generationSource: "llm" }));
    const fs = setupFs();
    const manifest = makeManifest();
    const callLlm = async () => "stub";
    const runner = new WireframeStageRunner({
      manifest,
      ventureRoot: "/v",
      fs,
      callLlm,
    });

    const result = await runner.run();
    expect(result.success).toBe(true);
    const ctx = stepSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.callLlm).toBe(callLlm);
    expect(ctx.deepResearch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: "wireframe-screen-patterns.md",
          excerpt: expect.stringContaining("Screen patterns"),
        }),
      ])
    );
    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
  });

  it("runs without callLlm and still succeeds", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = setupFs();
    const manifest = makeManifest();
    const runner = new WireframeStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("propagates a thrown step as WIREFRAME_STEP_THREW", async () => {
    stepSpy.mockReset();
    stepSpy.mockRejectedValue(new Error("disk full"));
    const fs = setupFs();
    const manifest = makeManifest();
    const runner = new WireframeStageRunner({ manifest, ventureRoot: "/v", fs });

    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WIREFRAME_STEP_THREW");
    expect(result.error?.message).toBe("disk full");
    expect(result.error?.recoverable).toBe(true);
  });

  it("advances stage-progress on success via the orchestrator", async () => {
    stepSpy.mockReset();
    stepSpy.mockResolvedValue(defaultStepResult());
    const fs = setupFs();
    const manifest = makeManifest();
    const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
    const runner = new WireframeStageRunner({ manifest, ventureRoot: "/v", fs });

    await orch.runStage(runner, { force: true });

    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees write
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("WIREFRAME");
  });
});

describe("WireframeStageRunner.validate()", () => {
  it("rejects when screens-canvas.json is missing", async () => {
    const fs = new InMemoryFs();
    // No screens canvas pre-written -- validate() should flag it.
    const runner = new WireframeStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.missingResources.join(" ")).toContain("PRODUCT_SPEC");
  });

  it("rejects when manifest.id is empty", async () => {
    const fs = setupFs();
    const runner = new WireframeStageRunner({
      manifest: makeManifest({ id: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts a complete manifest with screens canvas present", async () => {
    const fs = setupFs();
    const runner = new WireframeStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});
