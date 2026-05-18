/**
 * Slice 6 -- ops-tier Golden step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeploymentGuideStep,
  createFinancialModelStep,
  createTestingStrategyStep,
  type GoldenStepContext,
} from "../../src/node/golden/index.js";
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
  ventureRoot = await mkdtemp(join(tmpdir(), "golden-ops-"));
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

describe("createTestingStrategyStep", () => {
  it("emits deterministic TEST_TYPES baseline always", async () => {
    const result = await createTestingStrategyStep(ctx());
    expect(result.docId).toBe("testing-strategy");
    expect(result.placeholders.TEST_TYPES).toContain("Unit tests");
    expect(result.placeholders.TEST_TYPES).toContain("Performance tests");
    expect(result.placeholders.COVERAGE_TARGETS).toContain("80%");
  });

  it("appends audit gaps when audit report present", async () => {
    const auditsDir = join(ventureRoot, "07_build", "audits");
    await mkdir(auditsDir, { recursive: true });
    await writeFile(
      join(auditsDir, "audit.json"),
      JSON.stringify({
        findings: [
          { id: "f1", title: "missing e2e tests", category: "testing", recommendation: "add Playwright smoke" },
        ],
        coverage: { unit: 72, integration: 40, e2e: 0 },
      }),
      "utf-8"
    );
    const result = await createTestingStrategyStep(ctx());
    expect(result.placeholders.COVERAGE_TARGETS).toContain("Unit: 72%");
    expect(result.placeholders.COVERAGE_TARGETS).toContain("missing e2e tests");
    expect(result.sourcesRead).toContain("07_build/audits/audit.json");
  });
});

describe("createDeploymentGuideStep", () => {
  it("TODO when backend-export.json missing", async () => {
    const result = await createDeploymentGuideStep(ctx());
    expect(result.placeholders.STAGES).toMatch(/TODO/);
  });

  it("renders 3-env pipeline from backend-export.deployment", async () => {
    const dir = join(ventureRoot, "12_backend");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "backend-export.json"),
      JSON.stringify({
        framework: "Hono",
        database: "Postgres",
        deployment: { target: "Fly.io", environments: ["local", "staging", "production"], cicd: "GitHub Actions", migrations: "pnpm db:migrate" },
      }),
      "utf-8"
    );
    const result = await createDeploymentGuideStep(ctx());
    expect(result.placeholders.STAGES).toContain("### local");
    expect(result.placeholders.STAGES).toContain("### staging");
    expect(result.placeholders.STAGES).toContain("### production");
    expect(result.placeholders.STAGES).toContain("Fly.io");
    expect(result.placeholders.STAGES).toContain("GitHub Actions");
  });
});

describe("createFinancialModelStep", () => {
  it("renders REVENUE / COSTS / RUNWAY / HIRES from finance-plan.json", async () => {
    const dir = join(ventureRoot, "05_finance");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "finance-plan.json"),
      JSON.stringify({
        revenue: { monthlyRecurringTargetGbp: 25000, pricePointGbp: 49, targetCustomers: 510 },
        costs: {
          totalMonthlyGbp: 8200,
          items: [
            { name: "Hosting", monthlyGbp: 400 },
            { name: "LLM API", monthlyGbp: 600 },
          ],
        },
        runway: { startingBalanceGbp: 80000, monthsAtCurrentBurn: 10, breakEvenMonth: 9 },
        hires: [{ role: "Senior engineer", whenMonth: 6, monthlySalaryGbp: 6500 }],
        fundingRecommendation: "Bootstrap to break-even.",
      }),
      "utf-8"
    );
    const result = await createFinancialModelStep(ctx());
    expect(result.docId).toBe("financial-model");
    expect(result.placeholders.REVENUE).toContain("\u00a325,000/mo");
    expect(result.placeholders.REVENUE).toContain("510");
    expect(result.placeholders.COSTS).toContain("\u00a38,200");
    expect(result.placeholders.COSTS).toContain("Hosting");
    expect(result.placeholders.RUNWAY).toContain("10 months");
    expect(result.placeholders.HIRES).toContain("Senior engineer");
    expect(result.sourcesRead).toContain("05_finance/finance-plan.json");
  });

  it("LLM branch overwrites RUNWAY narrative", async () => {
    const dir = join(ventureRoot, "05_finance");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "finance-plan.json"),
      JSON.stringify({ runway: { monthsAtCurrentBurn: 8 } }),
      "utf-8"
    );
    const result = await createFinancialModelStep(
      ctx({ callLlm: async () => "Acme is on track for break-even by Q3." })
    );
    expect(result.usedLlm).toBe(true);
    expect(result.placeholders.RUNWAY).toBe("Acme is on track for break-even by Q3.");
  });
});
