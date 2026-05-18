/**
 * Slice 7 -- sales-marketing Tier-B step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGoToMarketPlanStep,
  createLaunchPlanStep,
  createSalesPlaybookStep,
  createWebsiteCopyStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-sm-"));
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

describe("createGoToMarketPlanStep", () => {
  it("renders deterministic CHANNELS + TIMELINE from launch-receipt.json", async () => {
    const dir = join(ventureRoot, "08_launch");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "launch-receipt.json"),
      JSON.stringify({
        channels: ["Product Hunt", "founder posts", "email list"],
        dates: [{ label: "Soft launch", date: "2026-06-01" }, { label: "Public launch", date: "2026-06-15" }],
      }),
      "utf-8"
    );
    const r = await createGoToMarketPlanStep(ctx());
    expect(r.placeholders.CHANNELS).toContain("Product Hunt");
    expect(r.placeholders.TIMELINE).toContain("2026-06-15");
  });

  it("LLM branch overwrites AUDIENCE when callLlm + brand-brief supplied", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "brand-brief.json"), JSON.stringify({ audience: "x" }), "utf-8");
    const r = await createGoToMarketPlanStep(
      ctx({ callLlm: async () => "Synthetic GTM audience paragraph." })
    );
    expect(r.usedLlm).toBe(true);
    expect(r.placeholders.AUDIENCE).toBe("Synthetic GTM audience paragraph.");
  });
});

describe("createSalesPlaybookStep", () => {
  it("renders stages + scripts blocks from crm-config.json", async () => {
    const dir = join(ventureRoot, "11_crm");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "crm-config.json"),
      JSON.stringify({
        pipeline: { stages: [{ name: "Discovery", description: "first call" }] },
        templates: { outreach: "Hi {{name}}, ..." },
      }),
      "utf-8"
    );
    const r = await createSalesPlaybookStep(ctx());
    expect(r.placeholders.STAGES).toContain("Discovery");
    expect(r.placeholders.SCRIPTS).toContain("outreach");
  });
});

describe("createWebsiteCopyStep", () => {
  it("LLM branch overwrites HOMEPAGE when callLlm + brand-brief supplied", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "brand-brief.json"), JSON.stringify({ mission: "x", audience: "y" }), "utf-8");
    const r = await createWebsiteCopyStep(
      ctx({ callLlm: async () => "Synthetic homepage hero copy." })
    );
    expect(r.usedLlm).toBe(true);
    expect(r.placeholders.HOMEPAGE).toBe("Synthetic homepage hero copy.");
  });
});

describe("createLaunchPlanStep", () => {
  it("renders DATES as a markdown table from launch-receipt.dates", async () => {
    const dir = join(ventureRoot, "08_launch");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "launch-receipt.json"),
      JSON.stringify({
        channels: ["X"],
        dates: [{ label: "Beta opens", date: "2026-06-01" }],
      }),
      "utf-8"
    );
    const r = await createLaunchPlanStep(ctx());
    expect(r.placeholders.DATES).toContain("| Milestone | Date |");
    expect(r.placeholders.DATES).toContain("Beta opens");
  });
});
