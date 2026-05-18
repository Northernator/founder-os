import { describe, expect, it } from "vitest";
import { createConfigOnlyProvider } from "../src/node.js";

describe("createConfigOnlyProvider", () => {
  const FIXED_NOW = "2026-05-12T12:00:00.000Z";

  it("reports always available", async () => {
    const provider = createConfigOnlyProvider();
    await expect(provider.available()).resolves.toBe(true);
  });

  it("provision returns instance with no baseUrl + no binaryPath", async () => {
    const provider = createConfigOnlyProvider({ now: () => FIXED_NOW });
    const inst = await provider.provision({
      ventureSlug: "demo",
      ventureRoot: "/tmp/demo",
      adminEmail: "admin@local",
    });
    expect(inst).toMatchObject({
      ventureSlug: "demo",
      engine: "config_only",
      baseUrl: undefined,
      binaryPath: undefined,
      provisionedAt: FIXED_NOW,
    });
    expect(typeof inst.notes).toBe("string");
  });

  it("applySchema captures collections in the snapshot", async () => {
    const provider = createConfigOnlyProvider();
    await provider.applySchema({
      ventureRoot: "/tmp/demo",
      baseUrl: "http://localhost",
      collections: [
        {
          name: "task",
          type: "base",
          fields: [],
          apiRules: {},
          indexes: [],
          softDelete: false,
        },
      ],
    });
    expect(provider.snapshot().collections).toHaveLength(1);
    expect(provider.snapshot().collections[0]?.name).toBe("task");
  });

  it("export emits engine=config_only with placeholder baseUrl", async () => {
    const provider = createConfigOnlyProvider({ now: () => FIXED_NOW });
    const exp = await provider.export(
      {
        ventureSlug: "demo",
        engine: "config_only",
        adminEmail: "admin@local",
        provisionedAt: FIXED_NOW,
      },
      []
    );
    expect(exp.engine).toBe("config_only");
    expect(exp.source).toBe("config_only");
    expect(exp.baseUrl).toBe("http://localhost");
    expect(exp.sdk.realtime).toBe(false);
    expect(exp.sdk.importPath).toBe("@/lib/backend");
    expect(exp.generatedAt).toBe(FIXED_NOW);
  });
});
