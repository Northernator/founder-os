/**
 * logo-svg-prompts.ts -- shared archetype prompts + SVG extraction.
 *
 * Two places generate logos:
 *   1. apps/founder-desktop/src/lib/brand-gen.ts -- the interactive
 *      Brand chat panel's "/logo" command. Used for live iteration.
 *   2. packages/pipeline-runner/src/steps/create-logo-pack.ts -- the
 *      brand stage runner. Used by Run-all-stages + BrandTab's
 *      "Generate Logo Pack" button.
 *
 * Both fire streamChat-style calls at a subscription-CLI provider
 * (Gemini CLI by default, but any subscription provider works since
 * Anthropic and Codex also output reasonable SVG). The model is asked
 * to return raw SVG markup; `extractSvg` peels out the <svg>...</svg>
 * substring from whatever the model wrapped it in.
 *
 * Lives in branding-core so both surfaces use the same prompts and
 * stay in lockstep -- if the chat-panel prompt drifts from the stage-
 * runner prompt, users get inconsistent logos depending on which
 * button they pressed. Single source of truth here prevents that.
 *
 * No API key, no Imagen, no raster -- the whole point of this path is
 * that it works on a Gemini Advanced (or Claude Pro / ChatGPT Plus)
 * subscription with no extra plumbing.
 */

/** All four archetypes the brand pipeline can request. */
export const LOGO_ARCHETYPES = ["wordmark", "lettermark", "icon-wordmark", "abstract-mark"] as const;
export type LogoArchetype = (typeof LOGO_ARCHETYPES)[number];

/** Human-visible captions per archetype -- used by both the Brand tab's
 *  candidate cards and the stage runner's log output. */
export const LOGO_ARCHETYPE_DESCRIPTIONS: Record<LogoArchetype, string> = {
  wordmark: "Typography-only -- name as the logo",
  lettermark: "Stylised initials as a symbol",
  "icon-wordmark": "Icon + name side by side",
  "abstract-mark": "Pure symbol, no letters",
};

/** Minimum brief shape the prompts need. Both call sites pass the full
 *  BrandBrief; we accept a structural subset so this module doesn't
 *  pull the full schema into its dep graph. */
export type LogoPromptBrief = {
  companyName: string;
  tagline?: string;
  toneOfVoice?: string;
  targetAudience?: string;
  personality: readonly string[];
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    text: string;
    background: string;
  };
};

export const SYSTEM_PROMPT_SVG =
  "You are a senior brand designer fluent in SVG. You output only raw SVG markup -- no explanation, no commentary, no markdown fences. Every response is valid SVG that renders in a modern browser. Keep it minimal and elegant: few elements, clean geometry, tasteful use of the brand palette. No filters, gradients, or effects unless specifically asked -- flat vector only. Never include <script> tags. Always include a viewBox attribute.";

/**
 * Build the user prompt for a given archetype. Specs are tight (exact
 * viewBox, what to use, what to avoid) because LLMs do much better
 * with concrete dimensions than vague "make it look good".
 */
export function buildArchetypePrompt(brief: LogoPromptBrief, archetype: LogoArchetype): string {
  const personality = brief.personality.length ? brief.personality.join(", ") : "balanced";
  const paletteLine = `Primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, text ${brief.palette.text}, background ${brief.palette.background}.`;
  const voice = brief.toneOfVoice ? ` Voice: ${brief.toneOfVoice}.` : "";
  const audience = brief.targetAudience ? ` Audience: ${brief.targetAudience}.` : "";
  const context = `Brand: ${brief.companyName}.${brief.tagline ? ` Tagline: ${brief.tagline}.` : ""}${voice}${audience} Personality: ${personality}. Palette -- ${paletteLine}`;

  switch (archetype) {
    case "wordmark":
      return `${context}\n\nDesign a pure WORDMARK logo -- typography only, no icon or shape. Use viewBox="0 0 400 120". The full company name should be rendered as SVG <text> elements with appropriate font-family, font-weight, letter-spacing. Allow playful treatments (custom character tweaks, ligature-style overlaps, colour accents between letters) but the whole thing must remain a wordmark, not gain a separate symbol. Use the primary palette colour for the main letters; secondary or accent sparingly if it adds meaning. Output ONLY raw SVG.`;
    case "lettermark":
      return `${context}\n\nDesign a LETTERMARK logo -- the initials of the company name (1-3 letters) as a stylized symbol. Use viewBox="0 0 200 200". Letters can be heavily stylized, overlapping, inside a geometric container, or treated as negative space. Use primary colour for the letterforms; secondary for any container or accent shape. Output ONLY raw SVG. The company initials should be visually prominent.`;
    case "icon-wordmark":
      return `${context}\n\nDesign a COMBINATION icon + wordmark logo. Use viewBox="0 0 560 160". Icon on the left inside a 140x140 area (centered vertically), wordmark on the right starting at x=180. Icon should be simple geometric shapes -- circles, triangles, rectangles, strokes -- that hint at the company purpose or personality. Icon colours from the primary palette; wordmark in primary or text colour. The two elements must feel like one system (shared stroke weight, shared colour logic). Output ONLY raw SVG.`;
    case "abstract-mark":
      return `${context}\n\nDesign an ABSTRACT MARK logo -- a pure geometric symbol with no letters. Use viewBox="0 0 200 200". Compose from primitives: circles, polygons, arcs, strokes. Aim for a memorable silhouette that would work at favicon size (16x16). Use primary and accent colours, maybe secondary as a supporting element. Avoid anything overly literal -- no smiley faces, no dollar signs, no arrows-for-growth. The mark should feel distinct and intentional. Output ONLY raw SVG.`;
  }
}

/**
 * Pull <svg>...</svg> out of a raw LLM response. Handles models that
 * preface with explanation paragraphs, return markdown fences, or
 * emit multi-SVG responses (we take the first).
 *
 * Returns empty string if no <svg> is found, or if the SVG contains a
 * <script> tag -- we never ask for executable JS and any presence is
 * a red flag (injection target if the SVG ever lands in innerHTML).
 */
export function extractSvg(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("<svg")) {
    const end = trimmed.lastIndexOf("</svg>");
    return end >= 0 ? trimmed.slice(0, end + 6) : "";
  }
  const start = trimmed.indexOf("<svg");
  if (start < 0) return "";
  const end = trimmed.indexOf("</svg>", start);
  if (end < 0) return "";
  const candidate = trimmed.slice(start, end + 6);
  if (/<script[\s>]/i.test(candidate)) return "";
  return candidate;
}
