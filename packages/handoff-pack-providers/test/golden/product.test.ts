/**
 * Slice 6 -- product-tier Golden step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMvpScopeStep,
  createPrdStep,
  createUserStoriesStep,
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
  ventureRoot = await mkdtemp(join(tmpdir(), "golden-product-"));
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

async function seedSpecCanvas(payload: Record<string, unknown>): Promise<void> {
  const dir = join(ventureRoot, "06_product", "specs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec-canvas.json"), JSON.stringify(payload, null, 2), "utf-8");
}

describe("createPrdStep", () => {
  it("renders FEATURES from spec-canvas", async () => {
    await seedSpecCanvas({
      productName: "Acme OS",
      features: [
        { name: "Generate handoff pack", description: "branded PDFs for every doc", priority: "P0", acceptanceCriteria: ["All 200 docs render", "Tier-A docs filled via LLM"] },
        { name: "Role packs", description: "8 bundles per role", priority: "P1" },
      ],
    });
    const result = await createPrdStep(ctx());
    expect(result.docId).toBe("prd");
    expect(result.placeholders.PRODUCT_NAME).toBe("Acme OS");
    expect(result.placeholders.FEATURES).toContain("Generate handoff pack");
    expect(result.placeholders.FEATURES).toContain("priority: P0");
    expect(result.placeholders.ACCEPTANCE_CRITERIA).toContain("All 200 docs render");
  });

  it("TODO when no spec-canvas", async () => {
    const result = await createPrdStep(ctx());
    expect(result.placeholders.FEATURES).toMatch(/TODO/);
    expect(result.placeholders.ACCEPTANCE_CRITERIA).toMatch(/TODO/);
  });
});

describe("createMvpScopeStep", () => {
  it("derives in-scope from P0 features when no explicit inScope", async () => {
    await seedSpecCanvas({
      features: [
        { name: "Feature A", priority: "P0" },
        { name: "Feature B", priority: "P0" },
        { name: "Feature C", priority: "P2" },
      ],
    });
    const result = await createMvpScopeStep(ctx());
    expect(result.placeholders.IN_SCOPE).toContain("Feature A");
    expect(result.placeholders.IN_SCOPE).toContain("Feature B");
    expect(result.placeholders.LATER).toContain("Feature C");
  });

  it("honours explicit inScope/outOfScope/later", async () => {
    await seedSpecCanvas({
      inScope: ["MVP feature 1", "MVP feature 2"],
      outOfScope: ["v2 thing"],
      laterScope: ["future thing"],
    });
    const result = await createMvpScopeStep(ctx());
    expect(result.placeholders.IN_SCOPE).toContain("MVP feature 1");
    expect(result.placeholders.OUT_OF_SCOPE).toContain("v2 thing");
    expect(result.placeholders.LATER).toContain("future thing");
  });
});

describe("createUserStoriesStep", () => {
  it("synthesises 'As a user, I want to...' lines from features", async () => {
    await seedSpecCanvas({
      features: [
        { name: "Export PDF", description: "Download a branded PDF of any doc" },
        { name: "Invite teammate", description: "Send an email invite to a teammate" },
      ],
    });
    const result = await createUserStoriesStep(ctx());
    expect(result.docId).toBe("user-stories");
    expect(result.placeholders.STORIES).toMatch(/As a user, I want to \*\*export pdf\*\*/);
    expect(result.placeholders.STORIES).toMatch(/As a user, I want to \*\*invite teammate\*\*/);
  });

  it("LLM branch overwrites STORIES", async () => {
    await seedSpecCanvas({ features: [{ name: "A", description: "B" }] });
    const result = await createUserStoriesStep(
      ctx({ callLlm: async () => "**Export PDF**\n- As a user, I want X..." })
    );
    expect(result.usedLlm).toBe(true);
    expect(result.placeholders.STORIES).toContain("Export PDF");
  });
});
