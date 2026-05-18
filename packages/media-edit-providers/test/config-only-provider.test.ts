import { describe, expect, it } from "vitest";
import { createConfigOnlyProvider } from "../src/config-only-provider.js";

describe("config_only provider", () => {
  const provider = createConfigOnlyProvider({
    rawReelPath: "/ventures/foo/10_media/exports/launch-reel.mp4",
    ventureSlug: "foo",
  });

  it("reports name=config_only", () => {
    expect(provider.name).toBe("config_only");
  });

  it("probe() always available", async () => {
    const res = await provider.probe();
    expect(res.engine).toBe("config_only");
    expect(res.available).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("prepareWorkspace() returns empty paths and writes nothing", async () => {
    const out = await provider.prepareWorkspace({
      schemaVersion: 1,
      ventureSlug: "foo",
      engine: "config_only",
      shots: [],
      exportTargetPath: "/exports/edited/final-reel.mp4",
      generatedAt: new Date().toISOString(),
    });
    expect(out.manifestPath).toBe("");
    expect(out.mediaDir).toBe("");
  });

  it("launch() reports spawned=true with no server fields", async () => {
    const out = await provider.launch({ manifestPath: "" });
    expect(out.spawned).toBe(true);
    expect(out.engine).toBe("config_only");
    expect(out.serverUrl).toBeUndefined();
    expect(out.pid).toBeUndefined();
  });

  it("awaitExport() returns receipt pointing at the raw reel", async () => {
    const receipt = await provider.awaitExport({
      expectedPath: "/should/be/ignored.mp4",
    });
    expect(receipt.engine).toBe("config_only");
    expect(receipt.reelPath).toBe(
      "/ventures/foo/10_media/exports/launch-reel.mp4",
    );
    expect(receipt.ventureSlug).toBe("foo");
    expect(receipt.meta?.source).toBe("config_only");
  });

  it("status() reports running=false", async () => {
    const res = await provider.status?.();
    expect(res?.running).toBe(false);
  });

  it("teardown() is a no-op", async () => {
    await expect(provider.teardown?.()).resolves.toBeUndefined();
  });
});
