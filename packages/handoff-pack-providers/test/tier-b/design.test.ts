/**
 * Slice 7 -- design Tier-B step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrandStrategyStep,
  createDesignHandoffStep,
  createLogoPackStep,
  type GoldenStepContext,
} from "../../src/node/tier-b/index.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: { primary: "#1F2937", secondary: "#6B7280", background: "#FFFFFF", text: "#111827" },
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
  extractedAt: "2026-05-17T00:00:00.000Z",
};
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-des-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) {
    await rm(ventureRoot, { recursive: true, force: true });
  }
});

function ctx(extra: Partial<GoldenStepContext> = {}): GoldenStepContext {
  return {
    ventureRoot,
    ventureName: "Acme Inc",
    ventureSlug: "acme",
    brandTokens: TOKENS,
    now: NOW,
    ...extra,
  };
}

describe("createBrandStrategyStep", () => {
  it("deterministic: pulls personality + positioning + promise from brand-brief", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "brand-brief.json"),
      JSON.stringify({
        personality: ["warm", "confident"],
        positioning: "For UK founders shipping their first SaaS.",
        promise: "Branded handoff packs in 2 weeks.",
      }),
      "utf-8"
    );
    const r = await createBrandStrategyStep(ctx());
    expect(r.placeholders.PERSONALITY).toContain("warm");
    expect(r.placeholders.POSITIONING).toContain("UK founders");
    expect(r.placeholders.PROMISE).toContain("2 weeks");
  });
});

describe("createLogoPackStep", () => {
  it("renders the primary logo path + lists exports/ entries", async () => {
    const dir = join(ventureRoot, "03_brand", "logo", "exports");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "logo-dark.svg"), "<svg/>", "utf-8");
    await writeFile(join(dir, "logo-light.svg"), "<svg/>", "utf-8");
    const r = await createLogoPackStep(ctx());
    expect(r.placeholders.LOGO_PRIMARY).toBe(".brand/logo.svg");
    expect(r.placeholders.LOGO_VARIANTS).toContain("logo-dark.svg");
    expect(r.placeholders.LOGO_VARIANTS).toContain("logo-light.svg");
  });
});

describe("createDesignHandoffStep", () => {
  it("renders sliders + tokens + a stable html hash from handoff-export.json", async () => {
    const dir = join(ventureRoot, "06_product", "stitch");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "handoff-export.json"),
      JSON.stringify({
        source: "codesign",
        parameters: [{ key: "primary", value: "#1F2937", label: "Primary colour" }],
        tokens: { spacing: 8 },
        html: "<html><body>x</body></html>",
      }),
      "utf-8"
    );
    const r = await createDesignHandoffStep(ctx());
    expect(r.placeholders.SLIDERS).toContain("primary");
    expect(r.placeholders.TOKENS).toContain("spacing");
    expect(r.placeholders.HTML_HASH).toMatch(/`[0-9a-f]{12}`/);
  });
});
