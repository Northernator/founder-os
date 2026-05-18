/**
 * Slice 7 -- company-control Tier-B step tests.
 *
 * Covers founder-vision (LLM-enabled) + risk-register (LLM-enabled).
 * Mirrors the slice-6 strategy.test.ts shape.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFounderVisionStep,
  createRiskRegisterStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "tierb-cc-"));
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

describe("createFounderVisionStep", () => {
  it("deterministic: pulls VISION + VALUES from brand-brief.json", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "brand-brief.json"),
      JSON.stringify({
        vision: "A branded handoff pack for every UK founder.",
        values: ["Clarity", "Ship-or-iterate", "UK-first"],
      }),
      "utf-8"
    );
    const r = await createFounderVisionStep(ctx());
    expect(r.docId).toBe("founder-vision");
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.COMPANY_NAME).toBe("Acme Inc");
    expect(r.placeholders.VISION).toContain("branded handoff pack");
    expect(r.placeholders.VALUES).toContain("Clarity");
    expect(r.placeholders.CURRENT_DATE).toBe("2026-05-17");
  });

  it("LLM branch overwrites VISION when callLlm supplied", async () => {
    const dir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "brand-brief.json"), JSON.stringify({ mission: "x" }), "utf-8");
    const r = await createFounderVisionStep(
      ctx({ callLlm: async () => "  Synthetic founder vision narrative.  " })
    );
    expect(r.usedLlm).toBe(true);
    expect(r.placeholders.VISION).toBe("Synthetic founder vision narrative.");
  });
});

describe("createRiskRegisterStep", () => {
  it("deterministic: emits category template with TODO callouts when no sources", async () => {
    const r = await createRiskRegisterStep(ctx());
    expect(r.docId).toBe("risk-register");
    expect(r.usedLlm).toBe(false);
    expect(r.placeholders.RISKS_BY_CATEGORY).toContain("Legal");
    expect(r.placeholders.RISKS_BY_CATEGORY).toContain("Financial");
    expect(r.placeholders.RISKS_BY_CATEGORY).toMatch(/TODO/);
  });

  it("deterministic: ingests audit findings into mapped category", async () => {
    const dir = join(ventureRoot, "07_build", "audits");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "audit.json"),
      JSON.stringify({
        findings: [
          { category: "security", recommendation: "rotate JWT signing keys" },
          { category: "legal compliance", recommendation: "wire DPA workflow" },
        ],
      }),
      "utf-8"
    );
    const r = await createRiskRegisterStep(ctx());
    expect(r.placeholders.RISKS_BY_CATEGORY).toContain("rotate JWT signing keys");
    expect(r.placeholders.RISKS_BY_CATEGORY).toContain("wire DPA workflow");
    expect(r.sourcesRead).toContain("07_build/audits/audit.json");
  });
});
