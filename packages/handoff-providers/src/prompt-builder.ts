/**
 * Pure prompt builder for Open CoDesign.
 *
 * Takes a CoDesign-shaped HandoffExport plus the originating BrandBrief
 * (and, optionally, the rendered screens) and returns a single Markdown
 * prompt the renderer can write to the OS clipboard. The user then
 * pastes this into Open CoDesign's first-prompt box and CoDesign emits
 * an HTML prototype that matches the brief, screens, and design tokens.
 *
 * Why a separate file (and not part of the launcher): this is the bit
 * we need running in the WebView -- the renderer builds the prompt,
 * stuffs it on the clipboard via `navigator.clipboard.writeText()`, then
 * asks Tauri to spawn the binary. Keeping this pure (no node:* imports)
 * keeps it bundleable by Vite.
 *
 * Drift protection: the heading strings emitted here are asserted in
 * test/prompt-builder.test.ts so downstream parsers / ScreensTab toast
 * copy stay in sync if we rename anything.
 */

import type { BrandBrief } from "@founder-os/branding-core";
import type { HandoffExport, SliderParam } from "@founder-os/handoff-contract";
import type { HandoffPromptResult } from "./types.js";

/**
 * Section headers we emit, in order. Asserted in tests so renames are
 * caught early. Anyone parsing the prompt back out (e.g. a future
 * round-trip importer) keys off these strings.
 */
export const CODESIGN_PROMPT_HEADERS = {
  title: "# Build the",
  whatSection: "## What we're building",
  brandSection: "## Brand",
  screensSection: "## Screens",
  tokensSection: "## Design tokens",
  slidersSection: "## Tunable sliders",
  outputSection: "## Output expectations",
} as const;

/**
 * Minimal shape of a screen for prompt rendering. Avoids importing the
 * full @founder-os/domain Screen + SHELL_TYPE_DESCRIPTIONS so this file
 * stays cheap; the desktop wiring (slice 3) passes pre-projected screens.
 */
export type PromptScreen = {
  name: string;
  description?: string;
  shellHint?: string;
  features?: ReadonlyArray<string>;
  entities?: ReadonlyArray<string>;
  notes?: string;
};

export type BuildCodesignPromptOpts = {
  brief: BrandBrief;
  /**
   * The HandoffExport CoDesign would otherwise emit. We mine it for
   * design tokens + the slider names so the prompt asks CoDesign to
   * preserve the existing parametric surface.
   */
  exportArtifact: HandoffExport;
  /**
   * Projected screens. Optional -- if omitted the prompt falls back to
   * "use sensible defaults" so the builder is still usable from
   * brief-only flows.
   */
  screens?: ReadonlyArray<PromptScreen>;
  /**
   * What we're building -- usually venture.manifest.appType. Drops into
   * the "What we're building" preamble.
   */
  appType?: string;
};

/**
 * Build the Markdown prompt. Pure -- no I/O, no clock reads (caller
 * decides whether to embed a timestamp upstream).
 */
export function buildCodesignPrompt(opts: BuildCodesignPromptOpts): HandoffPromptResult {
  const { brief, exportArtifact, screens = [], appType } = opts;
  const lines: string[] = [];

  // Title -- single H1.
  lines.push(`${CODESIGN_PROMPT_HEADERS.title} ${brief.companyName} prototype`);
  lines.push("");

  // What we're building.
  lines.push(CODESIGN_PROMPT_HEADERS.whatSection);
  const appLabel = (appType ?? "Web application").trim() || "Web application";
  lines.push(`${appLabel}. Tagline: "${brief.tagline}".`);
  if (brief.mission.trim()) {
    lines.push("");
    lines.push(`Mission: ${brief.mission.trim()}`);
  }
  if (brief.targetAudience.trim()) {
    lines.push("");
    lines.push(`Target audience: ${brief.targetAudience.trim()}`);
  }
  lines.push("");

  // Brand -- color palette + typography from the brief.
  lines.push(CODESIGN_PROMPT_HEADERS.brandSection);
  lines.push(`- Primary: ${brief.colorPalette.primary}`);
  lines.push(`- Secondary: ${brief.colorPalette.secondary}`);
  lines.push(`- Accent: ${brief.colorPalette.accent}`);
  lines.push(`- Background: ${brief.colorPalette.background}`);
  lines.push(`- Surface: ${brief.colorPalette.surface}`);
  lines.push(`- Text: ${brief.colorPalette.text}`);
  lines.push(`- Text muted: ${brief.colorPalette.textMuted}`);
  lines.push(
    `- Heading font: ${brief.typography.headingFont} (weight ${brief.typography.headingWeight})`,
  );
  lines.push(
    `- Body font: ${brief.typography.bodyFont} (weight ${brief.typography.bodyWeight})`,
  );
  if (brief.toneOfVoice.trim()) {
    lines.push(`- Tone of voice: ${brief.toneOfVoice.trim()}`);
  }
  if (brief.personality.length > 0) {
    lines.push(`- Personality: ${brief.personality.join(", ")}`);
  }
  lines.push("");

  // Screens -- one section per projected screen.
  lines.push(CODESIGN_PROMPT_HEADERS.screensSection);
  if (screens.length === 0) {
    lines.push(
      "_No screens projected yet -- use sensible defaults (onboarding / dashboard / settings)._",
    );
  } else {
    screens.forEach((screen, idx) => {
      const n = idx + 1;
      lines.push(`${n}. **${screen.name.trim() || `Screen ${n}`}**`);
      if (screen.description?.trim()) {
        lines.push(`   - ${screen.description.trim()}`);
      }
      if (screen.shellHint?.trim()) {
        lines.push(`   - Shell hint: ${screen.shellHint.trim()}`);
      }
      if (screen.features && screen.features.length > 0) {
        lines.push(`   - Features: ${screen.features.filter(Boolean).join(", ")}`);
      }
      if (screen.entities && screen.entities.length > 0) {
        lines.push(`   - Entities: ${screen.entities.filter(Boolean).join(", ")}`);
      }
      if (screen.notes?.trim()) {
        lines.push(`   - Notes: ${screen.notes.trim()}`);
      }
    });
  }
  lines.push("");

  // Design tokens -- harvested from the export so CoDesign sees the
  // same CSS-var names BUILD will eventually consume.
  lines.push(CODESIGN_PROMPT_HEADERS.tokensSection);
  const tokenLines = formatTokenLines(exportArtifact);
  if (tokenLines.length === 0) {
    lines.push("_No tokens supplied -- use the brand colors as the source of truth._");
  } else {
    for (const line of tokenLines) {
      lines.push(line);
    }
  }
  lines.push("");

  // Sliders -- preserve the parametric surface from the existing export.
  lines.push(CODESIGN_PROMPT_HEADERS.slidersSection);
  const sliderEntries = Object.entries(exportArtifact.parameters ?? {});
  if (sliderEntries.length === 0) {
    lines.push(
      "_No parametric sliders requested -- emit whichever knobs CoDesign would normally produce._",
    );
  } else {
    lines.push(
      `Surface ${sliderEntries.length} parametric slider(s), keyed exactly as below so the existing handoff contract stays compatible:`,
    );
    for (const [key, param] of sliderEntries) {
      lines.push(`- \`${key}\` (${param.type}) ${formatSliderTail(param)}`);
    }
  }
  lines.push("");

  // Output expectations -- explicit so CoDesign doesn't drift.
  lines.push(CODESIGN_PROMPT_HEADERS.outputSection);
  lines.push(
    "- Single HTML file with inlined CSS. No external JS frameworks.",
  );
  lines.push("- One `<section>` per screen above, in order.");
  lines.push(
    "- Use the brand color palette + typography exactly as listed; do not substitute Tailwind defaults.",
  );
  lines.push(
    "- Keep the CSS variable names listed under Design tokens -- BUILD downstream wires them into a generated CSS file.",
  );
  lines.push(
    "- Export ready-to-paste; we'll round-trip the result back into the Founder OS pipeline.",
  );

  const prompt = `${lines.join("\n")}\n`;
  return {
    prompt,
    characters: prompt.length,
    screenCount: screens.length,
  };
}

function formatTokenLines(exp: HandoffExport): string[] {
  const out: string[] = [];
  const tokens = exp.tokens;
  if (!tokens) return out;

  if (tokens.colors) {
    for (const [name, value] of Object.entries(tokens.colors)) {
      out.push(`- \`--color-${kebab(name)}\`: ${value}`);
    }
  }
  if (tokens.typography?.fontFamily) {
    out.push(`- \`--font-family\`: ${tokens.typography.fontFamily}`);
  }
  if (tokens.typography?.scale) {
    for (const [name, value] of Object.entries(tokens.typography.scale)) {
      out.push(`- \`--type-${kebab(name)}\`: ${String(value)}`);
    }
  }
  if (tokens.spacing) {
    for (const [name, value] of Object.entries(tokens.spacing)) {
      out.push(`- \`--space-${kebab(name)}\`: ${String(value)}`);
    }
  }
  if (tokens.radii) {
    for (const [name, value] of Object.entries(tokens.radii)) {
      out.push(`- \`--radius-${kebab(name)}\`: ${String(value)}`);
    }
  }
  return out;
}

function formatSliderTail(param: SliderParam): string {
  const bits: string[] = [];
  if (param.label) bits.push(`label="${param.label}"`);
  if (typeof param.value === "number") {
    bits.push(`value=${param.value}`);
  } else {
    bits.push(`value="${param.value}"`);
  }
  if (param.min !== undefined) bits.push(`min=${param.min}`);
  if (param.max !== undefined) bits.push(`max=${param.max}`);
  if (param.step !== undefined) bits.push(`step=${param.step}`);
  if (param.cssVar) bits.push(`cssVar=${param.cssVar}`);
  return bits.join(" ");
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}
