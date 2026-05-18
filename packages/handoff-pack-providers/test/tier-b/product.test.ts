/**
 * Slice 7 -- product Tier-B step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProductRoadmapStep,
  createProductVisionStep,
  createUserFlowsStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-prod-"));
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

describe("createProductVisionStep", () => {
  it("LLM branch overwrites VISION when callLlm supplied + brand-brief seeded", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "brand-brief.json"), JSON.stringify({ mission: "shipping handoff packs" }), "utf-8");
    const r = await createProductVisionStep(
      ctx({ callLlm: async () => "Synthetic product vision narrative." })
    );
    expect(r.usedLlm).toBe(true);
    expect(r.placeholders.VISION).toBe("Synthetic product vision narrative.");
  });
});

describe("createUserFlowsStep", () => {
  it("extracts per-screen Mermaid blocks from screens.md", async () => {
    const dir = join(ventureRoot, "06_product", "wireframes");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "screens.md"),
      "## Home\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Signup\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n",
      "utf-8"
    );
    const r = await createUserFlowsStep(ctx());
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.FLOWS).toContain("A --> B");
    expect(r.placeholders.FLOWS).toContain("X --> Y");
  });
});

describe("createProductRoadmapStep", () => {
  it("buckets features by priority into 3/6/12-month horizons", async () => {
    const dir = join(ventureRoot, "06_product", "specs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "spec-canvas.json"),
      JSON.stringify({
        features: [
          { name: "Auth", priority: "P0" },
          { name: "Billing", priority: "P1" },
          { name: "Reports", priority: "P3" },
        ],
      }),
      "utf-8"
    );
    const r = await createProductRoadmapStep(ctx());
    expect(r.placeholders.ROADMAP).toContain("3-month horizon");
    expect(r.placeholders.ROADMAP).toContain("Auth");
    expect(r.placeholders.ROADMAP).toContain("Billing");
    expect(r.placeholders.ROADMAP).toContain("Reports");
  });
});
