/**
 * Drift-protection tests for the CoDesign prompt builder.
 *
 * Asserts:
 *   - Every section header from CODESIGN_PROMPT_HEADERS appears in the
 *     emitted prompt, in order. Renaming a header without updating the
 *     downstream parser / ScreensTab toast copy will fail these tests
 *     early.
 *   - The brand palette + typography end up in the brand section as a
 *     bulleted list.
 *   - Screens are enumerated 1..N and missing-screen fallback fires.
 *   - Token harvesting reads from exportArtifact.tokens (NOT the brief)
 *     so we surface the same CSS-var names BUILD will eventually wire.
 *   - Sliders reproduce the parameters keys verbatim so the existing
 *     handoff contract stays compatible.
 *
 * Pure tests -- no spawn, no fs, no clock. Vitest's "node" env.
 */

import { describe, expect, it } from "vitest";
import type { BrandBrief } from "@founder-os/branding-core";
import type { HandoffExport } from "@founder-os/handoff-contract";
import {
  buildCodesignPrompt,
  CODESIGN_PROMPT_HEADERS,
  type PromptScreen,
} from "../src/prompt-builder.js";

const TEST_BRIEF: BrandBrief = {
  ventureId: "v-test",
  ventureSlug: "test-co",
  companyName: "TestCo",
  tagline: "Ship faster.",
  mission: "Help indie founders ship MVPs in a week.",
  targetAudience: "Solo founders learning to ship.",
  personality: ["bold", "warm"],
  toneOfVoice: "Direct, dry, helpful.",
  competitors: [],
  differentiators: [],
  colorPalette: {
    primary: "#c96442",
    secondary: "#0e0e10",
    accent: "#f5f0eb",
    background: "#fffaf6",
    surface: "#f4f0ec",
    text: "#111111",
    textMuted: "#555555",
  },
  typography: {
    bodyFont: "Inter",
    headingFont: "Söhne",
    bodyWeight: 400,
    headingWeight: 700,
    scaleBase: 16,
  },
  logoSpec: {
    style: "wordmark",
    tagline: "Ship faster.",
  },
  createdAt: new Date("2026-05-12T00:00:00Z").toISOString(),
  version: 1,
};

const TEST_EXPORT: HandoffExport = {
  source: "codesign",
  schemaVersion: 1,
  html: "<html><body>stub</body></html>",
  parameters: {
    colorPrimary: {
      label: "Primary",
      type: "color",
      value: "#c96442",
      cssVar: "--color-primary",
    },
    spacingBase: {
      label: "Spacing base",
      type: "number",
      value: 8,
      min: 4,
      max: 16,
      step: 2,
      cssVar: "--space-base",
    },
  },
  tokens: {
    colors: {
      primary: "#c96442",
      background: "#fffaf6",
    },
    typography: {
      fontFamily: "Inter",
      scale: {
        headingWeight: 700,
        bodyWeight: 400,
      },
    },
  },
  generatedAt: "2026-05-12T00:00:00Z",
  providerVersion: "codesign-stub@0.1",
  notes: "stub",
};

const TEST_SCREENS: ReadonlyArray<PromptScreen> = [
  {
    name: "Dashboard",
    description: "Main workspace.",
    shellHint: "Top-nav dashboard shell.",
    features: ["List ventures", "Resume last venture"],
    entities: ["Venture", "Run"],
    notes: "Default landing screen.",
  },
  {
    name: "Brief Editor",
    description: "Edit the brand brief.",
    features: ["Edit fields", "Validate"],
  },
];

describe("buildCodesignPrompt", () => {
  it("emits every section header in order", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
      screens: TEST_SCREENS,
      appType: "Desktop venture-management app",
    });

    const orderedHeaders = [
      CODESIGN_PROMPT_HEADERS.title,
      CODESIGN_PROMPT_HEADERS.whatSection,
      CODESIGN_PROMPT_HEADERS.brandSection,
      CODESIGN_PROMPT_HEADERS.screensSection,
      CODESIGN_PROMPT_HEADERS.tokensSection,
      CODESIGN_PROMPT_HEADERS.slidersSection,
      CODESIGN_PROMPT_HEADERS.outputSection,
    ];

    let cursor = 0;
    for (const header of orderedHeaders) {
      const idx = prompt.indexOf(header, cursor);
      expect(idx, `header "${header}" should appear after cursor ${cursor}`).toBeGreaterThanOrEqual(
        cursor,
      );
      cursor = idx + header.length;
    }
  });

  it("includes the brand company name in the title", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
    });
    expect(prompt).toContain("# Build the TestCo prototype");
    expect(prompt).toContain('Tagline: "Ship faster.".');
  });

  it("emits the brand palette + typography in the Brand section", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
    });
    expect(prompt).toContain("- Primary: #c96442");
    expect(prompt).toContain("- Background: #fffaf6");
    expect(prompt).toContain("- Heading font: Söhne (weight 700)");
    expect(prompt).toContain("- Body font: Inter (weight 400)");
    expect(prompt).toContain("- Personality: bold, warm");
  });

  it("enumerates screens 1..N when provided", () => {
    const { prompt, screenCount } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
      screens: TEST_SCREENS,
    });
    expect(screenCount).toBe(2);
    expect(prompt).toContain("1. **Dashboard**");
    expect(prompt).toContain("2. **Brief Editor**");
    expect(prompt).toContain("Features: List ventures, Resume last venture");
    expect(prompt).toContain("Entities: Venture, Run");
  });

  it("falls back to a default note when no screens are projected", () => {
    const { prompt, screenCount } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
    });
    expect(screenCount).toBe(0);
    expect(prompt).toContain("_No screens projected yet");
  });

  it("harvests token names from exportArtifact.tokens", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
    });
    expect(prompt).toContain("`--color-primary`: #c96442");
    expect(prompt).toContain("`--color-background`: #fffaf6");
    expect(prompt).toContain("`--font-family`: Inter");
    expect(prompt).toContain("`--type-heading-weight`: 700");
  });

  it("reproduces slider keys verbatim so the handoff contract stays compatible", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
    });
    expect(prompt).toContain("`colorPrimary` (color)");
    expect(prompt).toContain("`spacingBase` (number)");
    // SliderParam tail formatting should surface the cssVar so CoDesign
    // wires the slider into the same variable name BUILD expects.
    expect(prompt).toContain("cssVar=--color-primary");
    expect(prompt).toContain("cssVar=--space-base");
  });

  it("reports character count matching the emitted prompt length", () => {
    const result = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
      screens: TEST_SCREENS,
    });
    expect(result.characters).toBe(result.prompt.length);
  });

  it("treats blank appType as the default app label", () => {
    const { prompt } = buildCodesignPrompt({
      brief: TEST_BRIEF,
      exportArtifact: TEST_EXPORT,
      appType: "   ",
    });
    expect(prompt).toContain("Web application. Tagline:");
  });
});
