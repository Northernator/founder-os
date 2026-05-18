/**
 * prepareBrandAssetsStep tests. Covers fail-closed behaviour when
 * BRAND has not shipped, happy-path token extraction from a
 * brand-brief.json fixture, and brand-token JSON disk shape.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HandoffPackBrandMissingError,
  prepareBrandAssetsStep,
  projectBrandTokens,
} from "../src/node.js";

const FIXTURE_BRIEF = {
  ventureId: "vt-acme",
  ventureSlug: "acme",
  companyName: "Acme & Co",
  tagline: "Builders of widgets.",
  mission: "We make widgets people love.",
  targetAudience: "SaaS founders",
  personality: ["bold", "modern"],
  toneOfVoice: "warm, direct, technical",
  competitors: [],
  differentiators: [],
  colorPalette: {
    primary: "#ff6600",
    secondary: "#6b7280",
    accent: "#10b981",
    background: "#ffffff",
    surface: "#f9fafb",
    text: "#111827",
    textMuted: "#6b7280",
  },
  typography: {
    headingFont: "Cabinet Grotesk",
    bodyFont: "Inter",
    monoFont: "JetBrains Mono",
    headingWeight: 700,
    bodyWeight: 400,
    scaleBase: 16,
  },
  logoSpec: {
    style: "wordmark",
  },
  createdAt: "2026-05-17T00:00:00.000Z",
  version: 1,
};

let ventureRoot: string;

beforeAll(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "handoff-pack-pba-"));
});

describe("prepareBrandAssetsStep", () => {
  it("throws HandoffPackBrandMissingError when brand-brief.json is absent", async () => {
    await expect(
      prepareBrandAssetsStep({ ventureRoot })
    ).rejects.toBeInstanceOf(HandoffPackBrandMissingError);
  });

  it("extracts BrandTokens, writes .brand/, and surfaces logoCopied=false when no logo exists", async () => {
    // Lay down brand-brief.json + the .brand-kit/ folder under
    // 03_brand/ where prepareBrandAssetsStep expects them.
    const brandKitDir = join(ventureRoot, "03_brand", "brand-kit");
    await mkdir(brandKitDir, { recursive: true });
    const briefPath = join(brandKitDir, "brand-brief.json");
    await writeFile(briefPath, JSON.stringify(FIXTURE_BRIEF, null, 2), "utf-8");

    const result = await prepareBrandAssetsStep({
      ventureRoot,
      ventureName: FIXTURE_BRIEF.companyName,
      now: () => new Date("2026-05-17T12:00:00.000Z"),
    });

    expect(result.tokens.companyName).toBe("Acme & Co");
    expect(result.tokens.colors.primary).toBe("#FF6600");
    expect(result.tokens.fonts.heading).toBe("Cabinet Grotesk");
    expect(result.tokens.extractedAt).toBe("2026-05-17T12:00:00.000Z");
    expect(result.logoCopied).toBe(false);

    // brand-tokens.json + pdf-template-config.json on disk.
    const tokensJsonPath = join(
      ventureRoot,
      "13_handoff_pack",
      ".brand",
      "brand-tokens.json"
    );
    const tokensJson = JSON.parse(await readFile(tokensJsonPath, "utf-8"));
    expect(tokensJson.colors.primary).toBe("#FF6600");
    const configJsonPath = join(
      ventureRoot,
      "13_handoff_pack",
      ".brand",
      "pdf-template-config.json"
    );
    expect(existsSync(configJsonPath)).toBe(true);
  });
});

describe("projectBrandTokens", () => {
  it("uppercases hex values and falls back to defaults for missing fields", () => {
    const tokens = projectBrandTokens(
      {
        colorPalette: { primary: "#abcdef" },
        typography: {},
      },
      { ventureName: "X Corp", extractedAt: "2026-05-17T00:00:00.000Z" }
    );
    expect(tokens.colors.primary).toBe("#ABCDEF");
    // Missing fields fall back to documented defaults.
    expect(tokens.colors.secondary).toBe("#6B7280");
    expect(tokens.fonts.heading).toBe("Inter");
    expect(tokens.fonts.body).toBe("Inter");
    expect(tokens.fonts.mono).toBe("JetBrains Mono");
    expect(tokens.companyName).toBe("X Corp");
  });
});

afterAll(() => {
  // Vitest cleans up the OS tmp tree on its own; nothing to do.
  if (ventureRoot && !existsSync(ventureRoot)) {
    // sanity touch
  }
});
