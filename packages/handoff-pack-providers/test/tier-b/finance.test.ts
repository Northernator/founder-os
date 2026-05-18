/**
 * Slice 7 -- finance-admin Tier-B step tests (pure renders, no LLM).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCashflowForecastStep,
  createStartupBudgetStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-fin-"));
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

async function seedFinancePlan(payload: Record<string, unknown>): Promise<void> {
  const dir = join(ventureRoot, "05_finance");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "finance-plan.json"), JSON.stringify(payload), "utf-8");
}

describe("createStartupBudgetStep", () => {
  it("renders a markdown budget table with running total in GBP", async () => {
    await seedFinancePlan({
      startupBudget: [
        { category: "Domain + email", amountGbp: 100 },
        { category: "Stripe setup", amountGbp: 250, notes: "incl. test mode" },
        { category: "Legal review", amountGbp: 1200 },
      ],
    });
    const r = await createStartupBudgetStep(ctx());
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.CATEGORIES).toContain("| Category | Amount (GBP) |");
    expect(r.placeholders.CATEGORIES).toContain("Stripe setup");
    expect(r.placeholders.CATEGORIES).toContain("1,550");
    expect(r.sourcesRead).toContain("05_finance/finance-plan.json");
  });

  it("emits a TODO callout when finance-plan.json is missing", async () => {
    const r = await createStartupBudgetStep(ctx());
    expect(r.placeholders.CATEGORIES).toMatch(/TODO/);
    expect(r.sourcesRead).toHaveLength(0);
  });
});

describe("createCashflowForecastStep", () => {
  it("renders a monthly cashflow table from finance-plan.json", async () => {
    await seedFinancePlan({
      cashflow: [
        { month: "Jun 2026", revenueGbp: 0, expensesGbp: 1200, netGbp: -1200 },
        { month: "Jul 2026", revenueGbp: 500, expensesGbp: 1300, netGbp: -800 },
      ],
    });
    const r = await createCashflowForecastStep(ctx());
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.MONTHS).toContain("Jun 2026");
    expect(r.placeholders.MONTHS).toContain("Jul 2026");
    expect(r.placeholders.MONTHS).toContain("1,200");
  });
});
