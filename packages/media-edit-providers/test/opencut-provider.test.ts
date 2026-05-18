import { describe, expect, it, vi } from "vitest";
import type { SpawnBunDevResult } from "../src/spawn.js";
import { createOpencutProvider } from "../src/opencut-provider.js";

// Lightweight fake child handle -- only the kill/killed/pid surface
// touched by the provider.
function fakeChild(): SpawnBunDevResult["child"] {
  let killed = false;
  const child = {
    pid: 12345,
    get killed() {
      return killed;
    },
    kill: (_signal?: string) => {
      killed = true;
      return true;
    },
  } as unknown as SpawnBunDevResult["child"];
  return child;
}

function fakeSpawn(): (o: {
  cwd: string;
  port: number;
}) => Promise<SpawnBunDevResult> {
  return async (_o) => ({
    child: fakeChild(),
    pid: 12345,
    readyStdout: "Local:    http://localhost:3000\n",
  });
}

describe("opencut provider -- launch + status + teardown", () => {
  it("launch() returns serverUrl/port/pid; status() flips with teardown()", async () => {
    const provider = createOpencutProvider({
      vendorPath: "/fake/vendor/opencut",
      workDir: "/fake/work",
      port: 3000,
      openImpl: vi.fn(async () => {}),
      spawnImpl: fakeSpawn(),
    });

    const launched = await provider.launch({
      manifestPath: "/fake/work/clip-manifest.md",
    });
    expect(launched.spawned).toBe(true);
    expect(launched.serverUrl).toBe("http://localhost:3000");
    expect(launched.serverPort).toBe(3000);
    expect(launched.pid).toBe(12345);
    expect(launched.openedBrowser).toBe(true);

    const statusBefore = await provider.status?.();
    expect(statusBefore?.running).toBe(true);
    expect(statusBefore?.pid).toBe(12345);

    await provider.teardown?.();

    const statusAfter = await provider.status?.();
    expect(statusAfter?.running).toBe(false);
  });

  it("launch() returns spawned=false with error when spawn throws", async () => {
    const provider = createOpencutProvider({
      vendorPath: "/fake/vendor/opencut",
      workDir: "/fake/work",
      spawnImpl: async () => {
        throw new Error("simulated boot failure");
      },
    });
    const out = await provider.launch({ manifestPath: "/fake/work/clip-manifest.md" });
    expect(out.spawned).toBe(false);
    expect(out.error).toBe("simulated boot failure");
  });
});

describe("opencut provider -- awaitExport", () => {
  it("resolves with receipt once size is stable", async () => {
    // Simulate: poll 1 -> not present, poll 2 -> 100 bytes,
    // poll 3 -> 200 bytes (growing), poll 4 -> 200 bytes (stable 1),
    // poll 5 -> 200 bytes (stable 2 -> done).
    const sizes = [undefined, 100, 200, 200, 200];
    let i = 0;
    const provider = createOpencutProvider({
      vendorPath: "/fake/vendor/opencut",
      workDir: "/fake/work",
      pollIntervalMs: 1,
      stabilityChecks: 2,
      statImpl: async (_p) => {
        const v = sizes[i++ % sizes.length];
        if (v === undefined) throw new Error("ENOENT");
        return { size: v };
      },
    });
    const receipt = await provider.awaitExport({
      expectedPath:
        "/fake/ventures/demo/10_media/exports/edited/final-reel.mp4",
      timeoutMs: 5_000,
    });
    expect(receipt.engine).toBe("opencut");
    expect(receipt.ventureSlug).toBe("demo");
    expect(receipt.meta?.sizeBytes).toBe(200);
  });

  it("throws on timeout when file never appears", async () => {
    const provider = createOpencutProvider({
      vendorPath: "/fake/vendor/opencut",
      workDir: "/fake/work",
      pollIntervalMs: 1,
      statImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(
      provider.awaitExport({
        expectedPath: "/x/never.mp4",
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("aborts when signal already aborted", async () => {
    const provider = createOpencutProvider({
      vendorPath: "/fake/vendor/opencut",
      workDir: "/fake/work",
      pollIntervalMs: 1,
      statImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.awaitExport({
        expectedPath: "/x/never.mp4",
        timeoutMs: 10_000,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
