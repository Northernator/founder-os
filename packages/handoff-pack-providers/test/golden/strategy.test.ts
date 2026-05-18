/**
 * Slice 6 -- strategy-tier Golden step tests.
 *
 * Each test drives a single createXxxStep against a tmpdir-seeded
 * venture root and asserts:
 *   1. The step completes without throwing.
 *   2. Required placeholders are populated.
 *   3. Sources actually read match what the test laid down.
 *   4. The deterministic branch fires when callLlm is omitted.
 *   5. The LLM branch is invoked when callLlm is supplied and a
 *      narrative slot is overwritten.
 *
 * No PDF rendering -- those are slice-5's concern; here we exercise
 * the placeholder-producer half of the pipeline only.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCompanyBriefStep,
  createIcpPersonasStep,
  createMarketResearchStep,
  type GoldenStepContext,
} from "../../src/node/golden/index.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: {
    primary: "#1F2937",
    secondary: "#6B7280",
    background: "#FFFFFF",
    text: "#111827",
  },
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
  extractedAt: "2026-05-17T00:00:00.000Z",
};

const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "golden-strategy-"));
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

async function seedBrandBrief(payload: Record<string, unknown>): Promise<void> {
  const dir = join(ventureRoot, "03_brand", "brand-kit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "brand-brief.json"), JSON.stringify(payload, null, 2), "utf-8");
}

async function seedResearchSummary(content: string): Promise<void> {
  const dir = join(ventureRoot, "01_research", "saas");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "business-summary.md"), content, "utf-8");
}

describe("createCompanyBriefStep", () => {
  it("deterministic branch fills MISSION from brand-brief.json", async () => {
    await seedBrandBrief({
      mission: "Help UK founders ship operating-system docs in 2 weeks.",
      audience: "First-time UK SaaS founders.",
      productSummary: "Branded handoff packs auto-generated from pipeline outputs.",
    });
    const result = await createCompanyBriefStep(ctx());
    expect(result.docId).toBe("company-brief");
    expect(result.usedLlm).toBe(false);
    expect(result.placeholders.COMPANY_NAME).toBe("Acme Inc");
    expect(result.placeholders.MISSION).toContain("Help UK founders");
    expect(result.placeholders.CURRENT_DATE).toBe("2026-05-17");
    expect(result.sourcesRead).toContain("03_brand/brand-kit/brand-brief.json");
  });

  it("LLM branch overwrites MISSION when callLlm supplied", async () => {
    await seedBrandBrief({ mission: "Original mission text." });
    let calls = 0;
    const result = await createCompanyBriefStep(
      ctx({
        callLlm: async () => {
          calls++;
          return "  LLM-generated mission paragraph for Acme.  ";
        },
      })
    );
    expect(calls).toBe(1);
    expect(result.usedLlm).toBe(true);
    expect(result.placeholders.MISSION).toBe("LLM-generated mission paragraph for Acme.");
  });
});

describe("createMarketResearchStep", () => {
  it("deterministic: TODO callout when no research artefacts", async () => {
    const result = await createMarketResearchStep(ctx());
    expect(result.docId).toBe("market-research");
    expect(result.usedLlm).toBe(false);
    expect(result.placeholders.MARKET_SIZE).toMatch(/TODO/);
    expect(result.placeholders.TRENDS).toMatch(/TODO/);
  });

  it("reads market-research.md when present", async () => {
    const dir = join(ventureRoot, "01_research", "saas");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "market-research.md"),
      "# Acme research\n\n## Market size\n\nUK SMB SaaS spend exceeded \u00a318bn in 2024.\n\n## Trends\n\nVertical AI co-pilots are the dominant 2025 wave.\n",
      "utf-8"
    );
    const result = await createMarketResearchStep(ctx());
    expect(result.placeholders.MARKET_SIZE).toContain("\u00a318bn");
    expect(result.placeholders.TRENDS).toContain("AI co-pilots");
    expect(result.sourcesRead).toContain("01_research/saas/market-research.md");
  });
});

describe("createIcpPersonasStep", () => {
  it("deterministic: builds ICP block from validation-canvas.json", async () => {
    const validationDir = join(ventureRoot, "02_validation");
    await mkdir(validationDir, { recursive: true });
    await writeFile(
      join(validationDir, "validation-canvas.json"),
      JSON.stringify(
        {
          icpDescription: "Solo founder shipping their first SaaS in the UK.",
          icpRole: "Founder",
          icpPain: "Drowning in admin and template authoring.",
          icpCurrentSolution: "Copy-pasting Notion templates.",
          icpTrigger: "First hire incoming and needs a brief.",
        },
        null,
        2
      ),
      "utf-8"
    );
    const result = await createIcpPersonasStep(ctx());
    expect(result.docId).toBe("icp-personas");
    expect(result.placeholders.ICP).toContain("Solo founder");
    expect(result.placeholders.ICP).toContain("Drowning in admin");
    expect(result.sourcesRead).toContain("02_validation/validation-canvas.json");
  });

  it("LLM branch synthesises ICP narrative", async () => {
    const validationDir = join(ventureRoot, "02_validation");
    await mkdir(validationDir, { recursive: true });
    await writeFile(
      join(validationDir, "validation-canvas.json"),
      JSON.stringify({ icpDescription: "UK SMB owner-managers in services.", icpPain: "Manual reporting eats their week." }),
      "utf-8"
    );
    const result = await createIcpPersonasStep(
      ctx({
        callLlm: async () => "Synthetic ICP narrative paragraph.",
      })
    );
    expect(result.usedLlm).toBe(true);
    expect(result.placeholders.ICP).toBe("Synthetic ICP narrative paragraph.");
  });
});
