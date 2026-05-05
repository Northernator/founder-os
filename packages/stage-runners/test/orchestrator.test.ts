/**
 * PipelineOrchestrator behavior tests.
 *
 * Drives the orchestrator with a fake StageRunner that returns
 * hand-crafted StageRunResult objects. We don't run the real runners
 * here -- those are covered by their own runner-specific tests +
 * the smoke harness. The orchestrator's job is independent of the
 * runner body: validate, idempotency, persistence, advance progress,
 * approve/reject gates.
 */
import type { ReviewGate, StageName, StageRunResult, ValidationResult } from "@founder-os/domain";
import { describe, expect, it } from "vitest";
import { PipelineOrchestrator } from "../src/index.js";
import type { StageRunner } from "../src/types.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const STATE = "v/.founder/state";
const HANDOFF_FAILED = "v/.founder/handoffs/failed";

function makeFakeRunner(opts: {
  stageName?: StageName;
  validation?: ValidationResult;
  runResult?: StageRunResult | null;
}): StageRunner {
  const stageName = opts.stageName ?? "RESEARCH";
  return {
    stageName,
    async validate() {
      return opts.validation ?? { valid: true, missingResources: [], errors: [] };
    },
    async run() {
      if (opts.runResult) return opts.runResult;
      return {
        success: true,
        stageName,
        runId: "fake-run",
        artifactsCreated: [],
        logs: [],
        requiresReview: false,
        nextStageReady: true,
      };
    },
  };
}

function freshOrch() {
  const fs = new InMemoryFs();
  const manifest = makeManifest();
  const orch = new PipelineOrchestrator({ manifest, ventureRoot: "/v", fs });
  return { fs, orch, manifest };
}

describe("PipelineOrchestrator.runStage", () => {
  it("returns success and advances stage progress on a clean run", async () => {
    const { fs, orch } = freshOrch();
    const result = await orch.runStage(
      makeFakeRunner({
        runResult: {
          success: true,
          stageName: "RESEARCH",
          runId: "r1",
          artifactsCreated: ["/v/01_research/saas/ICP.md"],
          logs: [],
          requiresReview: false,
          nextStageReady: true,
        },
      }),
      { force: true }
    );
    expect(result.success).toBe(true);
    expect(result.stageName).toBe("RESEARCH");
    expect(result.artifactsCreated).toEqual(["/v/01_research/saas/ICP.md"]);
    expect(fs.files.has(`${STATE}/stage-progress.json`)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("RESEARCH");
    expect(sp.currentStage).toBe("RESEARCH");
  });

  it("short-circuits when stage already complete and force=false", async () => {
    const { fs, orch } = freshOrch();
    fs.files.set(
      `${STATE}/stage-progress.json`,
      JSON.stringify({
        currentStage: "RESEARCH",
        completedStages: ["RESEARCH"],
        startedAt: "2026-05-03T00:00:00Z",
      })
    );
    let runCalls = 0;
    const runner: StageRunner = {
      stageName: "RESEARCH",
      async validate() {
        return { valid: true, missingResources: [], errors: [] };
      },
      async run() {
        runCalls += 1;
        return {
          success: true,
          stageName: "RESEARCH",
          runId: "should-not-fire",
          artifactsCreated: [],
          logs: [],
          requiresReview: false,
          nextStageReady: true,
        };
      },
    };
    const result = await orch.runStage(runner, { force: false });
    expect(result.success).toBe(true);
    expect(runCalls).toBe(0);
  });

  it("ignores the short-circuit when force=true", async () => {
    const { fs, orch } = freshOrch();
    fs.files.set(
      `${STATE}/stage-progress.json`,
      JSON.stringify({
        currentStage: "RESEARCH",
        completedStages: ["RESEARCH"],
        startedAt: "2026-05-03T00:00:00Z",
      })
    );
    let runCalls = 0;
    const runner: StageRunner = {
      stageName: "RESEARCH",
      async validate() {
        return { valid: true, missingResources: [], errors: [] };
      },
      async run() {
        runCalls += 1;
        return {
          success: true,
          stageName: "RESEARCH",
          runId: "forced",
          artifactsCreated: [],
          logs: [],
          requiresReview: false,
          nextStageReady: true,
        };
      },
    };
    await orch.runStage(runner, { force: true });
    expect(runCalls).toBe(1);
  });

  it("validation failure -> success=false + VALIDATION_FAILED + persisted", async () => {
    const { fs, orch } = freshOrch();
    const result = await orch.runStage(
      makeFakeRunner({
        validation: { valid: false, missingResources: ["LLM"], errors: ["bad config"] },
      }),
      { force: true }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.recoverable).toBe(false);
    expect(fs.files.has(`${STATE}/failed-runs.json`)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const idx = JSON.parse(fs.files.get(`${STATE}/failed-runs.json`)!);
    expect(Array.isArray(idx) && idx.length).toBe(1);
  });

  it("runner-emitted failure persists handoff dump + index entry", async () => {
    const { fs, orch } = freshOrch();
    const result = await orch.runStage(
      makeFakeRunner({
        runResult: {
          success: false,
          stageName: "RESEARCH",
          runId: "r3",
          artifactsCreated: [],
          logs: [],
          requiresReview: false,
          nextStageReady: false,
          error: { code: "RESEARCH_REPORTS_ALL_FAILED", message: "all failed", recoverable: true },
        },
      }),
      { force: true }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("RESEARCH_REPORTS_ALL_FAILED");
    expect(fs.files.has(`${STATE}/failed-runs.json`)).toBe(true);
    expect(fs.files.has(`${HANDOFF_FAILED}/RESEARCH-r3.result.json`)).toBe(true);
  });

  it("approveReviewGate advances stage progress for the gate's stage", async () => {
    const { fs, orch } = freshOrch();
    // Pre-write a pending gate. The orchestrator's approve path
    // advances stage-progress server-side too.
    const gate: ReviewGate = {
      gateId: "gate-BRAND-r1",
      stageName: "BRAND",
      runId: "r1",
      requiredApproval: "business",
      status: "pending",
      createdAt: "2026-05-03T00:00:00Z",
      artifactsForReview: [],
    };
    fs.files.set(`${STATE}/review-gates.json`, JSON.stringify([gate]));
    await orch.approveReviewGate(gate.gateId, "tester");
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const sp = JSON.parse(fs.files.get(`${STATE}/stage-progress.json`)!);
    expect(sp.completedStages).toContain("BRAND");
  });
});
