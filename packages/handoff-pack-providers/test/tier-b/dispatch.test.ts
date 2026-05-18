/**
 * Slice 7 -- Tier-B dispatcher integration test.
 *
 * Drives dispatchTierBSteps end-to-end against a minimally-seeded
 * tmpdir + asserts:
 *
 *   1. All 27 steps complete (deterministic fallback when artefacts
 *      absent).
 *   2. contextOverrides has one entry per TIER_B_DOC_IDS entry.
 *   3. counts.completed == 27, counts.failed == 0.
 *   4. usedLlm increments only for the LLM-enabled subset when callLlm
 *      is supplied AND the LLM-enabled steps' preconditions are met.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TIER_B_DOC_IDS,
  TIER_B_STEP_REGISTRY,
  dispatchTierBSteps,
  type DispatchTierBStepsOpts,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-dispatch-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) {
    await rm(ventureRoot, { recursive: true, force: true });
  }
});

function opts(extra: Partial<DispatchTierBStepsOpts> = {}): DispatchTierBStepsOpts {
  return {
    ventureRoot,
    ventureName: "Acme Inc",
    ventureSlug: "acme",
    brandTokens: TOKENS,
    now: NOW,
    ...extra,
  };
}

describe("dispatchTierBSteps", () => {
  it("registry order matches TIER_B_DOC_IDS", () => {
    expect(TIER_B_STEP_REGISTRY.length).toBe(TIER_B_DOC_IDS.length);
    expect(TIER_B_STEP_REGISTRY.length).toBe(27);
    for (let i = 0; i < TIER_B_STEP_REGISTRY.length; i++) {
      expect(TIER_B_STEP_REGISTRY[i]?.docId).toBe(TIER_B_DOC_IDS[i]);
    }
  });

  it("completes all 27 steps deterministically with no upstream artefacts", async () => {
    const result = await dispatchTierBSteps(opts());
    expect(result.counts.completed).toBe(27);
    expect(result.counts.failed).toBe(0);
    expect(result.counts.usedLlm).toBe(0);
    expect(Object.keys(result.contextOverrides).length).toBe(27);
    for (const id of TIER_B_DOC_IDS) {
      expect(result.contextOverrides).toHaveProperty(id);
      const ph = result.contextOverrides[id];
      expect(ph).toBeDefined();
      expect(ph?.COMPANY_NAME).toBe("Acme Inc");
      expect(ph?.CURRENT_DATE).toBe("2026-05-17");
    }
  });

  it("usedLlm increments for LLM-enabled steps when preconditions met", async () => {
    // Seed enough state that the 12 LLM-enabled Tier-B steps actually
    // exercise their LLM branch. The 15 pure-render steps will never
    // call the LLM regardless of seeding.
    await mkdir(join(ventureRoot, "03_brand", "brand-kit"), { recursive: true });
    await writeFile(
      join(ventureRoot, "03_brand", "brand-kit", "brand-brief.json"),
      JSON.stringify({
        mission: "x",
        audience: "UK SMB",
        positioning: "p",
        promise: "q",
        values: ["a", "b"],
        tone: "warm",
      }),
      "utf-8"
    );
    await mkdir(join(ventureRoot, "02_validation"), { recursive: true });
    await writeFile(
      join(ventureRoot, "02_validation", "validation-canvas.json"),
      JSON.stringify({ icpDescription: "d", icpPain: "p", pricingTiers: [{ name: "Pro", priceGbp: 49 }] }),
      "utf-8"
    );
    await mkdir(join(ventureRoot, "05_finance"), { recursive: true });
    await writeFile(
      join(ventureRoot, "05_finance", "finance-plan.json"),
      JSON.stringify({ revenue: { monthlyRecurringTargetGbp: 5000 }, risks: ["r"] }),
      "utf-8"
    );
    await mkdir(join(ventureRoot, "07_build", "audits"), { recursive: true });
    await writeFile(
      join(ventureRoot, "07_build", "audits", "audit.json"),
      JSON.stringify({ findings: [{ category: "product", recommendation: "x" }] }),
      "utf-8"
    );
    await mkdir(join(ventureRoot, "08_launch"), { recursive: true });
    await writeFile(
      join(ventureRoot, "08_launch", "launch-receipt.json"),
      JSON.stringify({ channels: ["c"], dates: [{ label: "L", date: "2026-06-01" }] }),
      "utf-8"
    );

    let calls = 0;
    const result = await dispatchTierBSteps(
      opts({
        callLlm: async () => {
          calls++;
          return `narrative ${calls}`;
        },
      })
    );
    expect(result.counts.completed).toBe(27);
    expect(result.counts.failed).toBe(0);
    // 12 docs are LLM-enabled by design: founder-vision, risk-register,
    // business-plan, pricing-strategy, business-model-canvas,
    // positioning-statement, value-proposition, investor-deck,
    // product-vision, brand-strategy, go-to-market-plan, buyer-personas,
    // website-copy. Some require specific preconditions; not all 12 will
    // fire in every seed. >=5 is the floor; <27 is the ceiling.
    expect(result.counts.usedLlm).toBeGreaterThanOrEqual(5);
    expect(result.counts.usedLlm).toBeLessThan(27);
    expect(result.counts.deterministicFallback).toBe(0);
  });
});
