/**
 * Slice 7 -- strategy Tier-B step tests. Picks 3 representative docs
 * spanning LLM + pure-render branches.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBusinessPlanStep,
  createCompetitorAnalysisStep,
  createUnitEconomicsModelStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-strat-"));
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

describe("createBusinessPlanStep", () => {
  it("LLM branch overwrites MARKET when callLlm supplied + brand-brief seeded", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "brand-brief.json"),
      JSON.stringify({ audience: "UK SMB SaaS founders" }),
      "utf-8"
    );
    const r = await createBusinessPlanStep(
      ctx({ callLlm: async () => "Synthetic business-plan market narrative." })
    );
    expect(r.usedLlm).toBe(true);
    expect(r.placeholders.MARKET).toBe("Synthetic business-plan market narrative.");
    expect(r.placeholders.TEAM_PLAN).toMatch(/TODO/);
  });
});

describe("createCompetitorAnalysisStep", () => {
  it("renders a markdown table from research-summary.competitors", async () => {
    const dir = join(ventureRoot, "01_research", "saas");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "research-summary.json"),
      JSON.stringify({
        competitors: [
          { name: "BizPlanner", pricing: "GBP 49/mo", strengths: ["mature"], weaknesses: ["dated UX"] },
          { name: "FoundrTools", pricing: "GBP 99/mo", strengths: ["template library"], weaknesses: ["US-only"] },
        ],
      }),
      "utf-8"
    );
    const r = await createCompetitorAnalysisStep(ctx());
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.COMPETITORS).toContain("BizPlanner");
    expect(r.placeholders.COMPETITORS).toContain("FoundrTools");
    expect(r.placeholders.COMPETITORS).toContain("GBP 49/mo");
  });
});

describe("createUnitEconomicsModelStep", () => {
  it("renders CAC/LTV/CHURN/MARGINS placeholders from finance-plan.unitEconomics", async () => {
    const dir = join(ventureRoot, "05_finance");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "finance-plan.json"),
      JSON.stringify({
        unitEconomics: { cacGbp: 50, ltvGbp: 600, churnPct: 5, grossMarginPct: 80 },
      }),
      "utf-8"
    );
    const r = await createUnitEconomicsModelStep(ctx());
    expect(r.placeholders.CAC).toBe("£50");
    expect(r.placeholders.LTV).toBe("£600");
    expect(r.placeholders.CHURN).toBe("5%");
    expect(r.placeholders.MARGINS).toBe("80%");
  });

  it("emits TBD placeholders + a note when finance plan missing the block", async () => {
    const r = await createUnitEconomicsModelStep(ctx());
    expect(r.placeholders.CAC).toBe("TBD");
    expect(r.notes.some((n) => n.includes("unit-economics-model"))).toBe(true);
  });
});
