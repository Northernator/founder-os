/**
 * MediaEditStageRunner -- real-path tests (slice 4 of media-edit arc).
 *
 * Promoted from the skeletal placeholder in slice 3. The three new
 * pipeline-runner steps (createOpencutWorkspaceStep + launchOpencutStep
 * + awaitOpencutExportStep) are mocked here so the runner test doesn't
 * pull in real provider subprocesses + bun + fs polling, and exercises:
 *
 *   1. Success path: manifest + receipt + reel + checkpoint indexed,
 *      all 6 drift-protected log strings emitted.
 *   2. With provider undefined: falls back to slice-3 skeletal path.
 *   3. Step 1 "failed" (no upstream storyboard): runner surfaces
 *      MEDIA_EDIT_NO_UPSTREAM.
 *   4. Step 2 "failed" (bun spawn / port conflict): runner surfaces
 *      MEDIA_EDIT_LAUNCH_FAILED.
 *   5. Step 3 "timeout": runner emits a review gate and reports
 *      nextStageReady=false.
 *   6. Step 3 "aborted" (signal): runner reports success with
 *      nextStageReady=false (the founder will resume).
 *   7. Teardown is called on the provider in finally, even on failure.
 *
 * Mirrors media-runner-real.test.ts conventions.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const workspaceSpy = vi.fn();
const launchSpy = vi.fn();
const awaitSpy = vi.fn();

vi.mock("@founder-os/pipeline-runner", () => ({
  createOpencutWorkspaceStep: (ctx: unknown) => workspaceSpy(ctx),
  launchOpencutStep: (ctx: unknown) => launchSpy(ctx),
  awaitOpencutExportStep: (ctx: unknown) => awaitSpy(ctx),
}));

const { MediaEditStageRunner } = await import("../src/runners/media-edit-runner.js");

const okWorkspace = {
  status: "done" as const,
  manifestPath: "v/10_media/edits/clip-manifest.md",
  mediaDir: "v/10_media/renders",
  shotCount: 2,
  exportTargetPath: "v/10_media/exports/edited/final-reel.mp4",
};

const okLaunch = {
  status: "done" as const,
  spawned: true as const,
  pid: 99,
  serverUrl: "http://localhost:3000",
  serverPort: 3000,
  openedBrowser: true,
};

const okAwait = {
  status: "done" as const,
  receiptPath: "v/10_media/edits/edit-receipt.json",
  reelPath: "v/10_media/exports/edited/final-reel.mp4",
  durationSec: 47.5,
};

function makeFakeProvider(overrides: { teardownSpy?: ReturnType<typeof vi.fn> } = {}) {
  return {
    name: "opencut" as const,
    probe: async () => ({ engine: "opencut" as const, available: true }),
    prepareWorkspace: async () => ({
      manifestPath: okWorkspace.manifestPath,
      mediaDir: okWorkspace.mediaDir,
    }),
    launch: async () => ({
      engine: "opencut" as const,
      spawned: true,
      pid: okLaunch.pid,
      serverUrl: okLaunch.serverUrl,
      serverPort: okLaunch.serverPort,
      openedBrowser: okLaunch.openedBrowser,
    }),
    awaitExport: async () => ({
      schemaVersion: 1 as const,
      ventureSlug: "test",
      engine: "opencut" as const,
      reelPath: okAwait.reelPath,
      exportedAt: new Date().toISOString(),
    }),
    ...(overrides.teardownSpy ? { teardown: overrides.teardownSpy } : {}),
  };
}

describe("MediaEditStageRunner -- real success path", () => {
  it("indexes manifest + receipt + reel + checkpoint, emits all 6 log strings", async () => {
    workspaceSpy.mockReset().mockResolvedValue(okWorkspace);
    launchSpy.mockReset().mockResolvedValue(okLaunch);
    awaitSpy.mockReset().mockResolvedValue(okAwait);
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-real-1",
      provider: makeFakeProvider(),
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.stageName).toBe("MEDIA_EDIT");
    expect(result.nextStageReady).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        okWorkspace.manifestPath,
        okAwait.receiptPath,
        okAwait.reelPath,
        "v/10_media/edits/media-edit-checkpoint.json",
      ]),
    );
    const msgs = result.logs.map((l) => l.message);
    expect(msgs).toContain("MEDIA_EDIT stage starting");
    expect(msgs).toContain("media-edit: workspace prepared");
    expect(msgs).toContain("media-edit: editor launched");
    expect(msgs).toContain("media-edit: export detected");
    expect(msgs).toContain("media-edit: receipt written");
    expect(msgs).toContain("media-edit: checkpoint written");
  });
});

describe("MediaEditStageRunner -- skeletal back-compat", () => {
  it("falls back to slice-3 path when provider is undefined", async () => {
    workspaceSpy.mockReset();
    launchSpy.mockReset();
    awaitSpy.mockReset();
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-skel-1",
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    // No step should have been called.
    expect(workspaceSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(awaitSpy).not.toHaveBeenCalled();
    const msgs = result.logs.map((l) => l.message);
    expect(msgs).toContain("MEDIA_EDIT stage starting");
    expect(msgs).toContain("media-edit: checkpoint written");
    // Skeletal path does NOT emit the four intermediate strings.
    expect(msgs).not.toContain("media-edit: workspace prepared");
    expect(msgs).not.toContain("media-edit: editor launched");
  });
});

describe("MediaEditStageRunner -- failure modes", () => {
  it("step 1 'failed' surfaces MEDIA_EDIT_NO_UPSTREAM", async () => {
    workspaceSpy.mockReset().mockResolvedValue({
      status: "failed",
      reason: "no storyboard",
    });
    launchSpy.mockReset();
    awaitSpy.mockReset();
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-noupstream",
      provider: makeFakeProvider(),
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MEDIA_EDIT_NO_UPSTREAM");
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("step 2 'failed' surfaces MEDIA_EDIT_LAUNCH_FAILED", async () => {
    workspaceSpy.mockReset().mockResolvedValue(okWorkspace);
    launchSpy.mockReset().mockResolvedValue({
      status: "failed",
      spawned: false,
      error: "bun: command not found",
    });
    awaitSpy.mockReset();
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-launchfail",
      provider: makeFakeProvider(),
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MEDIA_EDIT_LAUNCH_FAILED");
    expect(result.error?.message).toContain("bun");
    expect(awaitSpy).not.toHaveBeenCalled();
  });

  it("step 3 'timeout' produces a review gate + nextStageReady=false", async () => {
    workspaceSpy.mockReset().mockResolvedValue(okWorkspace);
    launchSpy.mockReset().mockResolvedValue(okLaunch);
    awaitSpy.mockReset().mockResolvedValue({
      status: "timeout",
      error: "awaitExport timed out after 86400000ms",
    });
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-timeout",
      provider: makeFakeProvider(),
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.nextStageReady).toBe(false);
    expect(result.reviewGateId).toBeDefined();
  });

  it("step 3 'aborted' returns success with nextStageReady=false", async () => {
    workspaceSpy.mockReset().mockResolvedValue(okWorkspace);
    launchSpy.mockReset().mockResolvedValue(okLaunch);
    awaitSpy.mockReset().mockResolvedValue({
      status: "aborted",
      error: "awaitExport aborted by signal",
    });
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-aborted",
      provider: makeFakeProvider(),
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.nextStageReady).toBe(false);
  });
});

describe("MediaEditStageRunner -- teardown", () => {
  it("calls provider.teardown() in finally on success", async () => {
    workspaceSpy.mockReset().mockResolvedValue(okWorkspace);
    launchSpy.mockReset().mockResolvedValue(okLaunch);
    awaitSpy.mockReset().mockResolvedValue(okAwait);
    const teardownSpy = vi.fn(async () => {});
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-teardown-ok",
      provider: makeFakeProvider({ teardownSpy }),
    });
    await runner.run();
    expect(teardownSpy).toHaveBeenCalledTimes(1);
  });

  it("calls provider.teardown() even when a step throws", async () => {
    workspaceSpy.mockReset().mockRejectedValue(new Error("storyboard parse error"));
    launchSpy.mockReset();
    awaitSpy.mockReset();
    const teardownSpy = vi.fn(async () => {});
    const fs = new InMemoryFs();
    const runner = new MediaEditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      runId: "test-teardown-fail",
      provider: makeFakeProvider({ teardownSpy }),
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MEDIA_EDIT_STEP_THREW");
    expect(teardownSpy).toHaveBeenCalledTimes(1);
  });
});
