import type { LlmProviderId } from "@founder-os/llm-providers";
import { optimize } from "@founder-os/prompt-master";
/**
 * brand-gen.ts — AI-driven brand asset generation.
 *
 * These helpers wrap `streamChat` with prompts tuned to produce pure
 * SVG / HTML / Markdown output — no explanatory prose, no markdown
 * fences, nothing the UI has to strip. Each helper returns the final
 * asset string so the caller can either preview it (innerHTML / data
 * URL) or persist it to disk via `write_file`.
 *
 * Why SVG for logos/banners/etc: subscription-mode CLIs (Claude /
 * ChatGPT / Gemini) are code agents — they don't call DALL-E / Imagen.
 * But they're excellent at generating vector markup. SVG scales,
 * re-colours, and versions cleanly in git, and it round-trips to PNG
 * via `resvg` on the Rust side when we need a raster. For a brand
 * pack, SVG is actually the superior primitive.
 *
 * All prompts follow the same contract: "Output ONLY raw SVG. No
 * explanation, no markdown fences, no preamble." That combined with
 * `extractSvg` below handles the 5% of responses where the model can't
 * resist wrapping in ```svg``` fences anyway.
 */
import { injectImageRefs } from "./brand-chat/refs.js";
import { streamChat } from "./llm-client.js";

// ──────────────────────────────────────────────
// Brief shape (subset) — the parts we pass to the LLM as context
// ──────────────────────────────────────────────

/** Minimal brief slice that's enough to drive every generator. We
 *  deliberately narrow the full BrandBrief type so generators don't
 *  depend on the whole schema — keeps prompts focused and lets callers
 *  compose a partial brief for quick-fire generation before the full
 *  brief is saved. */
export type BrandGenBrief = {
  companyName: string;
  tagline?: string;
  mission?: string;
  targetAudience?: string;
  personality: string[];
  toneOfVoice?: string;
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface?: string;
    text: string;
    textMuted?: string;
  };
  typography?: {
    headingFont: string;
    bodyFont: string;
  };
};

// ──────────────────────────────────────────────
// Logo candidates — 4 archetypes in parallel
// ──────────────────────────────────────────────

/** Logo archetype label used in UI cards + prompts. */
export type LogoArchetype = "wordmark" | "lettermark" | "icon-wordmark" | "abstract-mark";

export type LogoCandidate = {
  archetype: LogoArchetype;
  svg: string;
  /** Short archetype description for the UI card subtitle. */
  description: string;
  /** Provider that generated this candidate. For the UI's "via" label. */
  provider: LlmProviderId;
};

export const SYSTEM_PROMPT_SVG =
  "You are a senior brand designer fluent in SVG. You output only raw SVG markup — no explanation, no commentary, no markdown fences. Every response is valid SVG that renders in a modern browser. Keep it minimal and elegant: few elements, clean geometry, tasteful use of the brand palette. No filters, gradients, or effects unless specifically asked — flat vector only. Never include <script> tags. Always include a viewBox attribute.";

function buildArchetypePrompt(brief: BrandGenBrief, archetype: LogoArchetype): string {
  const personality = brief.personality.length ? brief.personality.join(", ") : "balanced";
  const paletteLine = `Primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, text ${brief.palette.text}, background ${brief.palette.background}.`;
  const voice = brief.toneOfVoice ? ` Voice: ${brief.toneOfVoice}.` : "";
  const audience = brief.targetAudience ? ` Audience: ${brief.targetAudience}.` : "";
  const context = `Brand: ${brief.companyName}.${brief.tagline ? ` Tagline: ${brief.tagline}.` : ""}${voice}${audience} Personality: ${personality}. Palette — ${paletteLine}`;

  // Each archetype gets a tight spec — viewBox, what to use, what to
  // avoid. The LLM is much better with specific dimensions than
  // "make it look good."
  switch (archetype) {
    case "wordmark":
      return `${context}\n\nDesign a pure WORDMARK logo — typography only, no icon or shape. Use viewBox="0 0 400 120". The full company name should be rendered as SVG <text> elements with appropriate font-family, font-weight, letter-spacing. Allow playful treatments (custom character tweaks, ligature-style overlaps, colour accents between letters) but the whole thing must remain a wordmark, not gain a separate symbol. Use the primary palette colour for the main letters; secondary or accent sparingly if it adds meaning. Output ONLY raw SVG.`;
    case "lettermark":
      return `${context}\n\nDesign a LETTERMARK logo — the initials of the company name (1-3 letters) as a stylized symbol. Use viewBox="0 0 200 200". Letters can be heavily stylized, overlapping, inside a geometric container, or treated as negative space. Use primary colour for the letterforms; secondary for any container or accent shape. Output ONLY raw SVG. The company's initials should be visually prominent.`;
    case "icon-wordmark":
      return `${context}\n\nDesign a COMBINATION icon + wordmark logo. Use viewBox="0 0 560 160". Icon on the left inside a 140x140 area (centered vertically), wordmark on the right starting at x=180. Icon should be simple geometric shapes — circles, triangles, rectangles, strokes — that hint at the company's purpose or personality. Icon colours from the primary palette; wordmark in primary or text colour. The two elements must feel like one system (shared stroke weight, shared colour logic). Output ONLY raw SVG.`;
    case "abstract-mark":
      return `${context}\n\nDesign an ABSTRACT MARK logo — a pure geometric symbol with no letters. Use viewBox="0 0 200 200". Compose from primitives: circles, polygons, arcs, strokes. Aim for a memorable silhouette that would work at favicon size (16×16). Use primary and accent colours, maybe secondary as a supporting element. Avoid anything overly literal — no smiley faces, no dollar signs, no arrows-for-growth. The mark should feel distinct and intentional. Output ONLY raw SVG.`;
  }
}

const ARCHETYPE_DESCRIPTIONS: Record<LogoArchetype, string> = {
  wordmark: "Typography-only — name as the logo",
  lettermark: "Stylised initials as a symbol",
  "icon-wordmark": "Icon + name side by side",
  "abstract-mark": "Pure symbol, no letters",
};

/**
 * Fire 4 parallel streamChat calls for the 4 logo archetypes. Returns
 * an array of candidates in archetype order. Individual failures
 * surface as candidates with empty `svg` + an error on the caller's
 * `Promise.allSettled` branch — we use `Promise.all` with per-item
 * try/catch below so a single provider hiccup doesn't wipe the other 3.
 *
 * `signal` aborts ALL four in flight simultaneously. The returned
 * array will contain `svg: ""` for any that were aborted or errored,
 * with an `error` field for the caller to surface per-card.
 */
export async function generateLogoCandidates(opts: {
  brief: BrandGenBrief;
  provider: LlmProviderId;
  /** Optional venture id forwarded to Prompt Master telemetry so the
   *  Options-tab stats card can attribute tokens saved to this venture. */
  ventureId?: string;
  /** Optional reference image absolute paths. When provided, each
   *  archetype's user prompt is prefixed with `@<path>` tokens so a
   *  multimodal provider (e.g. gemini-cli subscription mode) treats
   *  them as style anchors. Empty / omitted = behaves as before. */
  imageRefs?: readonly string[];
  /** Optional subset of archetypes to generate. When omitted, all four
   *  fire in parallel as before. Used by the Brand chat panel's
   *  /logo <archetype> command to target a single archetype. */
  archetypes?: readonly LogoArchetype[];
  signal?: AbortSignal;
  onArchetypeStart?: (archetype: LogoArchetype) => void;
  onArchetypeDone?: (candidate: LogoCandidate & { error?: string }) => void;
}): Promise<(LogoCandidate & { error?: string })[]> {
  const ALL_ARCHETYPES: LogoArchetype[] = [
    "wordmark",
    "lettermark",
    "icon-wordmark",
    "abstract-mark",
  ];
  // When opts.archetypes is provided, run only that subset (preserving caller order).
  const archetypes: LogoArchetype[] = opts.archetypes
    ? opts.archetypes.filter((a) => ALL_ARCHETYPES.includes(a))
    : ALL_ARCHETYPES;

  // Optimise the shared SVG system prompt once, before fanning out the
  // four archetype calls. If we did it per-archetype, four parallel
  // optimize() calls would all miss the cache simultaneously and burn
  // four redundant transport hits.
  const optimizedSystem = await optimize({
    prompt: SYSTEM_PROMPT_SVG,
    context: "wireframe",
    ventureId: opts.ventureId,
  });
  console.info(
    "[prompt-master] brand-gen.logo",
    optimizedSystem.fallbackUsed
      ? "(fallback — transport unavailable)"
      : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
  );

  const results = await Promise.all(
    archetypes.map(async (archetype) => {
      opts.onArchetypeStart?.(archetype);
      try {
        // Refs (if any) ride into the user content as `@<abs-path>`
        // tokens. gemini-cli parses them itself; non-multimodal
        // providers will see them as literal text in the prompt body.
        const userContent = injectImageRefs(
          buildArchetypePrompt(opts.brief, archetype),
          opts.imageRefs ?? []
        );
        const raw = await streamChat({
          provider: opts.provider,
          system: optimizedSystem.optimized,
          messages: [{ role: "user", content: userContent }],
          temperature: 0.8,
          maxTokens: 2000,
          signal: opts.signal,
        });
        const svg = extractSvg(raw);
        const result: LogoCandidate & { error?: string } = {
          archetype,
          svg,
          description: ARCHETYPE_DESCRIPTIONS[archetype],
          provider: opts.provider,
        };
        if (!svg) {
          // Include a preview of the raw response so we can tell what
          // the model actually returned (markdown fences, prose,
          // truncated output, empty string, etc.).
          const preview = raw.trim().slice(0, 220);
          const tail = raw.length > 220 ? "..." : "";
          result.error = preview
            ? `Model returned no valid SVG. Raw response begins: ${preview}${tail}`
            : "Model returned an empty response. Check that gemini-cli is responsive.";
          console.warn("[brand-gen] extractSvg returned empty for", archetype, "; raw:", raw);
        }
        opts.onArchetypeDone?.(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result: LogoCandidate & { error?: string } = {
          archetype,
          svg: "",
          description: ARCHETYPE_DESCRIPTIONS[archetype],
          provider: opts.provider,
          error: msg,
        };
        opts.onArchetypeDone?.(result);
        return result;
      }
    })
  );

  return results;
}

// ──────────────────────────────────────────────
// Full brand pack — email header, social banners, brand guide
// ──────────────────────────────────────────────

export type BrandAssetSpec = {
  /** Key used as the file stem on disk and the UI card id. */
  key: string;
  /** User-visible title (card heading + filename). */
  title: string;
  /** Relative path under 03_brand/exports/ where the asset lands. */
  relPath: string;
  /** MIME-ish kind. Controls preview style + file extension. */
  kind: "svg" | "html" | "md";
  /** Build the prompt given the brief. The system prompt is fixed
   *  per-kind ("only raw SVG / only HTML / only Markdown"). */
  buildPrompt: (brief: BrandGenBrief, lockedLogoSvg: string) => string;
};

/** Canonical pack specs — one entry per asset. The order here drives
 *  the order in the UI progress list. */
export const FULL_PACK_SPECS: readonly BrandAssetSpec[] = [
  {
    key: "email-header",
    title: "Email header banner",
    relPath: "email/header.svg",
    kind: "svg",
    buildPrompt: (brief) =>
      `Design an email header banner SVG. Use viewBox="0 0 1200 300". Include the brand name "${brief.companyName}" as a wordmark on the left, vertically centred. Right side: a subtle abstract geometric composition in the brand palette — circles, rectangles, thin strokes. Must look calm and professional in both light and dark email clients. Palette: primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, text ${brief.palette.text}, background ${brief.palette.background}. No photographic imagery, no gradients, no filters. Flat vector only. Output ONLY raw SVG.`,
  },
  {
    key: "email-signature",
    title: "Email signature (HTML)",
    relPath: "email/signature.html",
    kind: "html",
    buildPrompt: (brief) =>
      `Build an HTML email signature template for ${brief.companyName}. Inline CSS only (no <style> tags, no external resources). Include placeholders [Name], [Title], [Email], [Phone] in square brackets so the user can find-and-replace. Use brand colours: primary ${brief.palette.primary}, text ${brief.palette.text}. Typography: heading font "${brief.typography?.headingFont ?? "Inter"}", body font "${brief.typography?.bodyFont ?? "Inter"}". Width: max 480px. Tasteful, minimal — name + title + brand name + contact details. Output ONLY the raw HTML (no <html>/<head>/<body> wrapper, no markdown fences, no explanation).`,
  },
  {
    key: "twitter-header",
    title: "X / Twitter header",
    relPath: "social/twitter-header.svg",
    kind: "svg",
    buildPrompt: (brief) =>
      `Design an X (Twitter) header banner SVG. Use viewBox="0 0 1500 500". Include the brand name "${brief.companyName}" prominently${brief.tagline ? ` with the tagline "${brief.tagline}" beneath` : ""}. Compose an abstract geometric background in the brand palette — no photos, no gradients. Remember the centre-bottom area (approximately x=80–200, y=340–500) will be partially obscured by the profile picture circle, so keep that zone clear of critical text. Palette: primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, background ${brief.palette.background}. Output ONLY raw SVG.`,
  },
  {
    key: "linkedin-banner",
    title: "LinkedIn banner",
    relPath: "social/linkedin-banner.svg",
    kind: "svg",
    buildPrompt: (brief) =>
      `Design a LinkedIn profile/page banner SVG. Use viewBox="0 0 1584 396". Include the brand name "${brief.companyName}"${brief.tagline ? ` and tagline "${brief.tagline}"` : ""}, positioned left of centre. Compose an abstract geometric background in the brand palette — no photos, no gradients. Leave the lower-left quadrant relatively clear (the profile picture overlay lives around x=80, y=200, radius ~80). Aim for a calm professional look. Palette: primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, text ${brief.palette.text}, background ${brief.palette.background}. Output ONLY raw SVG.`,
  },
  {
    key: "og-image",
    title: "OpenGraph image (social preview)",
    relPath: "social/og-image.svg",
    kind: "svg",
    buildPrompt: (brief) =>
      `Design an OpenGraph / social-preview image SVG. Use viewBox="0 0 1200 630". Hero the brand name "${brief.companyName}" centered${brief.tagline ? ` with the tagline "${brief.tagline}" underneath` : ""}. Add subtle geometric decoration in the corners and margins. Must be legible when scaled down to 400×210 in Twitter/Slack previews — so use large type, high contrast, and no fine detail. Palette: primary ${brief.palette.primary}, secondary ${brief.palette.secondary}, accent ${brief.palette.accent}, text ${brief.palette.text}, background ${brief.palette.background}. Output ONLY raw SVG.`,
  },
  {
    key: "brand-guide",
    title: "Brand guidelines (Markdown)",
    relPath: "docs/brand-guide.md",
    kind: "md",
    buildPrompt: (brief) =>
      `Write the brand guidelines document for ${brief.companyName} in pure Markdown. Output structure (use exactly these H2 section headings): "Identity", "Voice & Tone", "Colour palette", "Typography", "Logo usage", "Email & social guidelines". Include the following concrete details verbatim in the right sections:\n- Tagline: ${brief.tagline ?? "(none set)"}\n- Mission: ${brief.mission ?? "(none set)"}\n- Audience: ${brief.targetAudience ?? "(none set)"}\n- Personality: ${brief.personality.join(", ") || "(none set)"}\n- Tone of voice: ${brief.toneOfVoice ?? "(none set)"}\n- Primary ${brief.palette.primary} / Secondary ${brief.palette.secondary} / Accent ${brief.palette.accent} / Text ${brief.palette.text} / Background ${brief.palette.background}\n- Heading font: ${brief.typography?.headingFont ?? "Inter"}, body font: ${brief.typography?.bodyFont ?? "Inter"}\n\nUse short paragraphs and bulleted usage rules ("Do use…", "Don't use…"). Avoid filler. Output ONLY the Markdown document, no code fences around the whole thing, no preamble.`,
  },
] as const;

/**
 * Run the full-pack generator. Callers receive incremental updates via
 * the `onProgress` callback (one event per asset transitioning to
 * running/done/error) plus the final results array. Each asset gets
 * its own streamChat call in parallel; one failure does not abort the
 * others (we use `Promise.allSettled` semantics via per-item catch).
 *
 * `lockedLogoSvg` is the user's chosen logo SVG — passed into every
 * prompt so assets reference the real brand mark rather than improvising.
 */
export type PackAssetResult = {
  spec: BrandAssetSpec;
  content: string;
  error?: string;
};

export async function generateFullPack(opts: {
  brief: BrandGenBrief;
  provider: LlmProviderId;
  lockedLogoSvg: string;
  /** Optional venture id forwarded to Prompt Master telemetry so the
   *  Options-tab stats card can attribute tokens saved to this venture. */
  ventureId?: string;
  signal?: AbortSignal;
  onAssetStart?: (spec: BrandAssetSpec) => void;
  onAssetDone?: (result: PackAssetResult) => void;
}): Promise<PackAssetResult[]> {
  return Promise.all(
    FULL_PACK_SPECS.map(async (spec) => {
      opts.onAssetStart?.(spec);
      try {
        const system = systemPromptFor(spec.kind);
        // The pack runs all six assets in parallel, but each spec.kind
        // may pick a different system prompt — optimise per-call rather
        // than once outside. Repeated kinds (e.g. multiple "svg" specs)
        // share a cache key so only the first burst pays the optimizer
        // round-trip; the rest hit the LRU.
        const optimizedSystem = await optimize({
          prompt: system,
          context: "wireframe",
          ventureId: opts.ventureId,
        });
        console.info(
          `[prompt-master] brand-gen.${spec.key}`,
          optimizedSystem.fallbackUsed
            ? "(fallback — transport unavailable)"
            : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
        );
        const raw = await streamChat({
          provider: opts.provider,
          system: optimizedSystem.optimized,
          messages: [
            {
              role: "user",
              content: spec.buildPrompt(opts.brief, opts.lockedLogoSvg),
            },
          ],
          temperature: spec.kind === "md" ? 0.6 : 0.8,
          maxTokens: spec.kind === "md" ? 4000 : 2500,
          signal: opts.signal,
        });
        const content =
          spec.kind === "svg"
            ? extractSvg(raw)
            : spec.kind === "html"
              ? extractHtml(raw)
              : extractMarkdown(raw);
        const result: PackAssetResult = { spec, content };
        if (!content) {
          result.error = "Model returned empty content. Retry this asset.";
        }
        opts.onAssetDone?.(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result: PackAssetResult = {
          spec,
          content: "",
          error: msg,
        };
        opts.onAssetDone?.(result);
        return result;
      }
    })
  );
}

function systemPromptFor(kind: BrandAssetSpec["kind"]): string {
  switch (kind) {
    case "svg":
      return SYSTEM_PROMPT_SVG;
    case "html":
      return "You output only raw HTML with inline CSS — no <html>, <head>, or <body> wrappers, no external stylesheets or scripts, no markdown fences, no explanation. The output must be safe to paste directly into an email client.";
    case "md":
      return "You output only clean Markdown — no code fences wrapping the whole document, no preamble, no meta-commentary. Use standard Markdown syntax (heading hashes, hyphens for bullets, asterisks for emphasis).";
  }
}

// ──────────────────────────────────────────────
// Parsers — peel off accidental wrappers
// ──────────────────────────────────────────────

/** Extract the `<svg>…</svg>` tag from a raw LLM response. Handles the
 *  common cases: bare SVG (returns as-is), SVG wrapped in ```svg fences,
 *  SVG after a leading explanation paragraph, multi-SVG responses (we
 *  take the first). Returns empty string if no <svg> found. */
export function extractSvg(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Fast path: already starts with <svg.
  if (trimmed.startsWith("<svg")) {
    const end = trimmed.lastIndexOf("</svg>");
    return end >= 0 ? trimmed.slice(0, end + 6) : "";
  }
  // Scan for the first <svg and match through </svg>. Using indexOf
  // instead of regex so a 10kb response doesn't trigger catastrophic
  // backtracking on some deranged model output.
  const start = trimmed.indexOf("<svg");
  if (start < 0) return "";
  const end = trimmed.indexOf("</svg>", start);
  if (end < 0) return "";
  const candidate = trimmed.slice(start, end + 6);
  // Paranoia: reject SVGs containing <script> tags. We never ask for
  // them, and injecting one into innerHTML would be a very bad day.
  if (/<script[\s>]/i.test(candidate)) return "";
  return candidate;
}

/** Pull HTML out of a markdown-fenced or bare response. Strips
 *  ```html fences and leading whitespace. Returns the raw string if
 *  it already looks like HTML. */
export function extractHtml(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Handle ```html … ``` fences.
  const fenced = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/** Markdown extractor — strips only the outer ``` fence if the whole
 *  response is wrapped (models sometimes do this despite being asked
 *  not to). Otherwise returns the string as-is. */
export function extractMarkdown(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

// ──────────────────────────────────────────────
// Palette extraction from an SVG
// ──────────────────────────────────────────────

/** Scan an SVG string for unique fill/stroke hex colours. Returns them
 *  in order of appearance, deduplicated, lowercased. Used to seed the
 *  palette after the user picks a logo — we don't force overwrite, the
 *  caller decides which slots to fill. */
export function extractPaletteFromSvg(svg: string): string[] {
  if (!svg) return [];
  const colours = new Set<string>();
  const out: string[] = [];
  // Match attribute-based colours: fill="#abc" / stroke="#abcdef".
  const attrRe = /(?:fill|stroke)\s*=\s*"(#[0-9a-fA-F]{3,8})"/g;
  // Also style="fill:#abc" / style="stroke:#abc".
  const styleRe = /(?:fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/g;
  for (const re of [attrRe, styleRe]) {
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: intentional assign-and-test pattern
    while ((match = re.exec(svg)) !== null) {
      const hex = match[1].toLowerCase();
      // Skip the "none" sentinel — SVGs often have fill="none" which
      // won't match the regex anyway, but future-proof against similar.
      if (hex === "#000000" && colours.size > 3) continue; // de-prioritise boring black overflows
      if (!colours.has(hex)) {
        colours.add(hex);
        out.push(hex);
      }
    }
  }
  return out;
}
