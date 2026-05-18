/**
 * Slice 6 -- design-tier Golden steps.
 *
 * Three docs:
 *   - brand-guide    -- colours / fonts / tone / voice.
 *   - design-system  -- tokens / components / handoff sliders.
 *   - wireframe-pack -- per-screen layouts (markdown + mermaid).
 *
 * NODE-ONLY. Reads 03_brand/brand-kit/brand-brief.json,
 * 06_product/stitch/handoff-export.json, 06_product/wireframes/.
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getHandoffExportPath,
  getScreensCanvasPath,
  getScreensMarkdownPath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readJsonIfExists,
  readTextIfExists,
  todoCallout,
  truncate,
} from "./helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shape stubs
// ---------------------------------------------------------------------------

type BrandBriefLike = {
  mission?: string;
  tone?: string | string[];
  voice?: string;
  colorPalette?: {
    primary?: string;
    secondary?: string;
    background?: string;
    text?: string;
  };
  typography?: {
    headingFont?: string;
    bodyFont?: string;
    monoFont?: string;
  };
};

type HandoffExportLike = {
  source?: string;
  parameters?: Array<{ key?: string; value?: unknown; label?: string }>;
  tokens?: {
    colors?: Record<string, string>;
    typography?: Record<string, string>;
    spacing?: Record<string, string | number>;
  };
};

type ScreensCanvasLike = {
  screens?: Array<{
    id?: string;
    name?: string;
    shellType?: string;
    features?: string[];
    notes?: string;
  }>;
};

// ---------------------------------------------------------------------------
// brand-guide
// ---------------------------------------------------------------------------

export const createBrandGuideStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await readJsonIfExists<BrandBriefLike>(
    join(getBrandKitDir(ctx.ventureRoot), "brand-brief.json")
  );
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");

  // The brand tokens have already been extracted by prepareBrandAssetsStep,
  // so ctx.brandTokens is the source of truth here. brand-brief.json is
  // just for tone/voice extras.
  const tokens = ctx.brandTokens;
  const toneRaw = brandBrief?.tone;
  const tone = Array.isArray(toneRaw)
    ? toneRaw.filter((t) => typeof t === "string" && t.trim().length > 0).join(", ")
    : (toneRaw ?? "").toString().trim();

  const detTone = tone
    || (brandBrief?.voice ?? "").trim()
    || todoCallout("TONE", "set tone in 03_brand/brand-kit/brand-brief.json");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    PRIMARY_HEX: tokens.colors.primary,
    SECONDARY_HEX: tokens.colors.secondary,
    HEADING_FONT: tokens.fonts.heading,
    BODY_FONT: tokens.fonts.body,
    TONE: truncate(detTone, 800),
  };

  let usedLlm = false;
  if (ctx.callLlm && (tone || brandBrief?.voice)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the TONE & VOICE section of a brand guide for "${ctx.ventureName}". Output 1-2 paragraphs of plain prose explaining when to use which voice. ~120-200 words. Plain prose, no bullets.`,
        user: `Tone keywords: ${tone || "(none)"}\nVoice notes: ${brandBrief?.voice ?? "(none)"}\nMission: ${brandBrief?.mission ?? "(none)"}`,
      });
      placeholders.TONE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`brand-guide: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "brand-guide", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// design-system
// ---------------------------------------------------------------------------

export const createDesignSystemStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const handoffExport = await readJsonIfExists<HandoffExportLike>(
    getHandoffExportPath(ctx.ventureRoot)
  );
  if (handoffExport) sourcesRead.push("06_product/stitch/handoff-export.json");

  // TOKENS: combine brandTokens + handoff token slot if present.
  const tokens = ctx.brandTokens;
  const tokenLines: string[] = [
    `- **Primary colour:** \`${tokens.colors.primary}\``,
    `- **Secondary colour:** \`${tokens.colors.secondary}\``,
    `- **Background:** \`${tokens.colors.background}\``,
    `- **Text:** \`${tokens.colors.text}\``,
    `- **Heading font:** ${tokens.fonts.heading}`,
    `- **Body font:** ${tokens.fonts.body}`,
    `- **Mono font:** ${tokens.fonts.mono}`,
  ];
  if (handoffExport?.tokens?.spacing) {
    for (const [k, v] of Object.entries(handoffExport.tokens.spacing)) {
      tokenLines.push(`- **Spacing \`${k}\`:** ${v}`);
    }
  }

  // COMPONENTS: derive from handoff parameters (e.g. cornerRadius, density).
  const params = Array.isArray(handoffExport?.parameters) ? handoffExport!.parameters! : [];
  const componentLines: string[] = [];
  if (params.length === 0) {
    componentLines.push(
      todoCallout("COMPONENTS", "no handoff parameters -- run HANDOFF stage to capture sliders/tokens")
    );
  } else {
    componentLines.push("Component variants derived from handoff parameters:");
    componentLines.push("");
    for (const p of params.slice(0, 20)) {
      const key = (p.key ?? p.label ?? "param").toString();
      const value = p.value === undefined ? "TBD" : String(p.value);
      componentLines.push(`- **${key}:** ${value}`);
    }
  }

  // SLIDERS: same params surfaced as the handoff slider register.
  const sliderLines = params.length === 0
    ? todoCallout("SLIDERS", "no handoff sliders captured")
    : bulletList(
        params.slice(0, 12).map((p) => `${p.label ?? p.key ?? "slider"}: ${String(p.value ?? "TBD")}`),
        todoCallout("SLIDERS", "no slider params in handoff-export")
      );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    TOKENS: tokenLines.join("\n"),
    COMPONENTS: componentLines.join("\n"),
    SLIDERS: sliderLines,
  };

  let usedLlm = false;
  if (ctx.callLlm && params.length > 0) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the COMPONENTS overview for a design system used by "${ctx.ventureName}". Output a markdown bullet list of the core components (button, input, card, modal, nav, table, form). For each, note 1-2 variants + any state notes. ~200-400 words.`,
        user: `Handoff parameters:\n${JSON.stringify(params.slice(0, 25), null, 2)}\nTokens:\n${JSON.stringify(handoffExport?.tokens ?? {}, null, 2)}`,
      });
      placeholders.COMPONENTS = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`design-system: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "design-system", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// wireframe-pack
// ---------------------------------------------------------------------------

export const createWireframePackStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const screensMd = await readTextIfExists(getScreensMarkdownPath(ctx.ventureRoot));
  if (screensMd) sourcesRead.push("06_product/wireframes/screens.md");

  const screensCanvas = await readJsonIfExists<ScreensCanvasLike>(
    getScreensCanvasPath(ctx.ventureRoot)
  );
  if (screensCanvas) sourcesRead.push("06_product/wireframes/screens-canvas.json");

  const screens = Array.isArray(screensCanvas?.screens) ? screensCanvas!.screens! : [];

  let detScreens: string;
  if (screensMd && screensMd.trim().length > 0) {
    // The slice-5 WIREFRAME step already emits a beautifully-formatted
    // screens.md with per-screen mermaid + narratives. Reuse it.
    detScreens = truncate(screensMd, 5000);
  } else if (screens.length > 0) {
    detScreens = screens
      .slice(0, 30)
      .map((s, idx) => {
        const name = s.name?.trim() || `Screen ${idx + 1}`;
        const shell = s.shellType?.trim() || "shell unspecified";
        const features = Array.isArray(s.features) && s.features.length > 0
          ? `Features: ${s.features.join(", ")}`
          : "Features: (none captured)";
        const notesLine = s.notes?.trim() ? `Notes: ${s.notes.trim()}` : "";
        return [`### ${name}`, `_Shell:_ ${shell}`, "", features, notesLine].filter((l) => l.length > 0).join("\n");
      })
      .join("\n\n");
  } else {
    detScreens = todoCallout("SCREENS", "no screens-canvas.json -- run WIREFRAME stage first");
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    SCREENS: detScreens,
  };

  // No LLM call here -- screens.md is already LLM-enriched by the
  // WIREFRAME stage. Re-running an LLM pass would just churn content.

  return { docId: "wireframe-pack", placeholders, sourcesRead, usedLlm: false, notes };
};

// Silence unused-warning for the imported type if narrowing tightens later.
export type { GoldenStepResult };
