/**
 * Slice 6 -- design-tier Golden step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrandGuideStep,
  createDesignSystemStep,
  createWireframePackStep,
  type GoldenStepContext,
} from "../../src/node/golden/index.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: { primary: "#FF6B35", secondary: "#004E89", background: "#FFFFFF", text: "#111827" },
  fonts: { heading: "Geist", body: "Inter", mono: "JetBrains Mono" },
  extractedAt: "2026-05-17T00:00:00.000Z",
};
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "golden-design-"));
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

describe("createBrandGuideStep", () => {
  it("uses brandTokens for colours + fonts; tone from brand-brief", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "brand-brief.json"),
      JSON.stringify({ tone: ["confident", "warm", "specific"] }),
      "utf-8"
    );
    const result = await createBrandGuideStep(ctx());
    expect(result.docId).toBe("brand-guide");
    expect(result.placeholders.PRIMARY_HEX).toBe("#FF6B35");
    expect(result.placeholders.SECONDARY_HEX).toBe("#004E89");
    expect(result.placeholders.HEADING_FONT).toBe("Geist");
    expect(result.placeholders.BODY_FONT).toBe("Inter");
    expect(result.placeholders.TONE).toContain("confident");
    expect(result.placeholders.TONE).toContain("warm");
  });

  it("TONE TODO callout when brand-brief.json missing", async () => {
    const result = await createBrandGuideStep(ctx());
    expect(result.placeholders.TONE).toMatch(/TODO/);
    expect(result.placeholders.PRIMARY_HEX).toBe("#FF6B35");
  });
});

describe("createDesignSystemStep", () => {
  it("renders TOKENS bullet list always", async () => {
    const result = await createDesignSystemStep(ctx());
    expect(result.placeholders.TOKENS).toContain("#FF6B35");
    expect(result.placeholders.TOKENS).toContain("Geist");
  });

  it("populates COMPONENTS + SLIDERS from handoff-export.json", async () => {
    const stitchDir = join(ventureRoot, "06_product", "stitch");
    await mkdir(stitchDir, { recursive: true });
    await writeFile(
      join(stitchDir, "handoff-export.json"),
      JSON.stringify({
        source: "codesign",
        parameters: [
          { key: "cornerRadius", value: 8, label: "Corner radius" },
          { key: "density", value: "comfortable", label: "Density" },
        ],
        tokens: { spacing: { "1": "4px", "2": "8px" } },
      }),
      "utf-8"
    );
    const result = await createDesignSystemStep(ctx());
    expect(result.placeholders.COMPONENTS).toContain("cornerRadius");
    expect(result.placeholders.COMPONENTS).toContain("density");
    expect(result.placeholders.SLIDERS).toContain("Corner radius: 8");
    expect(result.placeholders.TOKENS).toContain("4px");
  });
});

describe("createWireframePackStep", () => {
  it("reads screens.md when present", async () => {
    const dir = join(ventureRoot, "06_product", "wireframes");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "screens.md"),
      "# Screens\n\n## Login\n\nA login screen with email + magic link.\n",
      "utf-8"
    );
    const result = await createWireframePackStep(ctx());
    expect(result.placeholders.SCREENS).toContain("Login");
    expect(result.placeholders.SCREENS).toContain("magic link");
    expect(result.usedLlm).toBe(false);
    expect(result.sourcesRead).toContain("06_product/wireframes/screens.md");
  });

  it("falls back to canvas when screens.md missing", async () => {
    const dir = join(ventureRoot, "06_product", "wireframes");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "screens-canvas.json"),
      JSON.stringify({
        screens: [
          { name: "Dashboard", shellType: "app", features: ["KPI cards", "Activity feed"] },
        ],
      }),
      "utf-8"
    );
    const result = await createWireframePackStep(ctx());
    expect(result.placeholders.SCREENS).toContain("Dashboard");
    expect(result.placeholders.SCREENS).toContain("KPI cards");
  });
});
