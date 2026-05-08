/**
 * MediaStageRunner -- real-path tests.
 *
 * Slice 4 of the media arc promoted MediaStageRunner from a self-contained
 * skeletal placeholder to a 4-step orchestrator wrapping pipeline-runner
 * steps. These tests mock all four steps so the runner test does not pull
 * in pipeline-runner internals + ffmpeg + provider subprocesses, and exercise:
 *
 *   1. Success path: 5 artifacts indexed (script-json + script-md +
 *      storyboard + per-shot render + launch-reel), 5 drift-protected
 *      log strings emitted, stage progress advanced.
 *   2. With LLM caller: callLlm is forwarded into the script step ctx.
 *   3. Pending-flow: render step returns status:"pending-flow" -- runner
 *      writes flow-prompts.md, skips stitch, creates a review gate
 *      regardless of pipeline.reviewGates config, marks
 *      requiresReview=true / nextStageReady=false.
 *   4. Failure path: a thrown step propagates as MEDIA_STEP_THREW.
 *
 * Mirrors validation/wireframe/finance/launch real-path tests.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const scriptSpy = vi.fn();
const storyboardSpy = vi.fn();
const renderSpy = vi.fn();
const stitchSpy = vi.fn();

vi.mock("@founder-os/pipeline-runner", () => ({
  createMediaScriptStep: (ctx: unknown) => scriptSpy(ctx),
  createStoryboardStep: (ctx: unknown) => storyboardSpy(ctx),
  createRenderShotsStep: (ctx: unknown) => renderSpy(ctx),
  createStitchStep: (ctx: unknown) => stitchSpy(ctx),
}));

const { MediaStageRunner } = await import("../src/runners/media-runner.js");

const okScript = {
  status: "done" as const,
  jsonPath: "v/10_media/scripts/media-script.json",
  mdPath: "v/10_media/scripts/media-script.md",
  generationSource: "deterministic" as const,
  sources: ["launch-announcement.md"],
  script: {
    schemaVersion: 1 as const,
    ventureSlug: "test",
    intent: "IDEA_TO_VIDEO" as const,
    scenes: [
      { id: "scene-1", durationSec: 6, voiceover: "v1", onScreen: "Title", visualBrief: "Title card" },
      { id: "scene-2", durationSec: 5, voiceover: "v2", onScreen: "Demo", visualBrief: "Product UI demo" },
    ],
    generatedAt: "2026-05-07T00:00:00Z",
  },
};

const okStoryboard = {
  status: "done" as const,
  jsonPath: "v/10_media/storyboards/storyboard.json",
  shotCount: 2,
  storyboard: {
    schemaVersion: 1 as const,
    scriptId: "test-run-1",
    ventureSlug: "test",
    shots: [
      { sceneId: "scene-1", engineHint: "hyperframes" as const, prompt: "p1", durationSec: 6 },
      { sceneId: "scene-2", engineHint: "hyperframes" as const, prompt: "p2", durationSec: 5 },
    ],
    generatedAt: "2026-05-07T00:00:00Z",
  },
};

const okRender = {
  status: "done" as const,
  rendersDir: "v/10_media/renders",
  shotCount: 2,
  successCount: 2,
  failureCount: 0,
  pendingFlowCount: 0,
  perShotResults: [
    { sceneId: "scene-1", status: "rendered" as const, engine: "hyperframes" as const,
      path: "v/10_media/renders/scene-1.mp4", durationSec: 6 },
    { sceneId: "scene-2", status: "rendered" as const, engine: "hyperframes" as const,
      path: "v/10_media/renders/scene-2.mp4", durationSec: 5 },
  ],
};

const okStitch = {
  status: "done" as const,
  reelPath: "v/10_media/exports/launch-reel.mp4",
  shotCount: 2,
};

describe("MediaStageRunner -- success path", () => {
  it("indexes 5 artifacts and emits all 5 drift-protected log strings", async () => {
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);
    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-run-1",
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.stageName).toBe("MEDIA");
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        okScript.jsonPath,
        okScript.mdPath,
        okStoryboard.jsonPath,
        "v/10_media/renders/scene-1.mp4",
        "v/10_media/renders/scene-2.mp4",
        okStitch.reelPath,
      ]),
    );
    const msgs = result.logs.map((l) => l.message);
    expect(msgs).toContain("MEDIA stage starting");
    expect(msgs).toContain("media script written");
    expect(msgs).toContain("storyboard written");
    expect(msgs).toContain("render-shots finished");
    expect(msgs).toContain("launch reel stitched");
  });

  it("forwards callLlm into the script step ctx", async () => {
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);
    const fs = new InMemoryFs();
    const fakeLlm = vi.fn(async () => "stubbed");
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: fakeLlm,
      runId: "test-run-llm",
    });
    await runner.run();
    expect(scriptSpy).toHaveBeenCalledTimes(1);
    const ctx = scriptSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.callLlm).toBe(fakeLlm);
  });

  it("succeeds without an LLM caller (deterministic path)", async () => {
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(okRender);
    stitchSpy.mockReset().mockResolvedValue(okStitch);
    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-run-no-llm",
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    const ctx = scriptSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("callLlm" in ctx).toBe(false);
  });
});

describe("MediaStageRunner -- pending-flow short-circuit", () => {
  it("writes flow-prompts.md, skips stitch, creates a review gate", async () => {
    const pendingRender = {
      status: "pending-flow" as const,
      rendersDir: "v/10_media/renders",
      flowPromptsPath: "v/10_media/flow-prompts.md",
      shotCount: 2,
      successCount: 0,
      failureCount: 0,
      pendingFlowCount: 2,
      perShotResults: [
        { sceneId: "scene-1", status: "pending-flow" as const, prompt: "p1", durationSec: 6 },
        { sceneId: "scene-2", status: "pending-flow" as const, prompt: "p2", durationSec: 5 },
      ],
    };
    scriptSpy.mockReset().mockResolvedValue(okScript);
    storyboardSpy.mockReset().mockResolvedValue(okStoryboard);
    renderSpy.mockReset().mockResolvedValue(pendingRender);
    stitchSpy.mockReset();
    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-run-pending",
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.nextStageReady).toBe(false);
    expect(result.reviewGateId).toBeDefined();
    // Stitch must NOT have been called when render reported pending-flow.
    expect(stitchSpy).not.toHaveBeenCalled();
    expect(result.artifactsCreated).toContain("v/10_media/flow-prompts.md");
    expect(result.artifactsCreated).not.toContain("v/10_media/exports/launch-reel.mp4");
  });
});

describe("MediaStageRunner -- failure path", () => {
  it("surfaces a thrown step as MEDIA_STEP_THREW", async () => {
    scriptSpy.mockReset().mockRejectedValue(new Error("LLM timed out"));
    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-run-fail",
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MEDIA_STEP_THREW");
    expect(result.error?.message).toContain("LLM timed out");
    expect(result.error?.recoverable).toBe(true);
    expect(result.nextStageReady).toBe(false);
  });
});
