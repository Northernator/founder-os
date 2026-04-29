/**
 * Palette presets — sourced from `nice-color-palettes` (mattdesl, 1000-set,
 * curated from ColourLovers).
 *
 * The source is a flat list of 5-color palettes; the brand canvas needs a
 * 7-slot ColorPalette (primary / secondary / accent / background / surface /
 * text / textMuted). This module:
 *
 *   1. Maps each 5-color array to the 7-slot shape via a luminance- and
 *      saturation-aware heuristic (see `mapToBrandPalette`).
 *   2. Auto-categorises each preset into one bucket (Vibrant, Pastel, Dark,
 *      Mono, Warm, Cool, Earthy, Muted) so the picker can render a
 *      categorised dropdown without hand-labelling 1000 palettes.
 *   3. Keeps the original four hand-picked presets in a "Featured" bucket
 *      at the top.
 *
 * No runtime npm dependency — the JSON ships in-bundle. Tauri desktop app,
 * so the ~50KB cost is irrelevant; bundling avoids any registry / install
 * coupling.
 */

import type { ColorPalette } from "@founder-os/branding-core";
import sourcePalettes from "./palette-presets-source.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PresetCategory =
  | "featured"
  | "vibrant"
  | "pastel"
  | "dark"
  | "mono"
  | "warm"
  | "cool"
  | "earthy"
  | "muted";

export type PalettePreset = {
  /** Stable identifier — `${category}-${index}` for derived presets. */
  id: string;
  /** Short human label, e.g. "Featured · Bold" or "Palette #042". */
  label: string;
  category: PresetCategory;
  palette: ColorPalette;
  /** Original 5 source colors, preserved for the swatch-strip preview. */
  swatch: readonly string[];
};

export type CategoryGroup = {
  key: PresetCategory;
  label: string;
  presets: PalettePreset[];
};

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

/** Parse `#rgb` / `#rrggbb` to [r,g,b] in 0..255. Returns null if invalid. */
function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    const r = Number.parseInt(h[0] + h[0], 16);
    const g = Number.parseInt(h[1] + h[1], 16);
    const b = Number.parseInt(h[2] + h[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  if (h.length === 6) {
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  return null;
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** WCAG-style relative luminance in 0..1. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Convert RGB (0..255) to HSL (h: 0..360, s/l: 0..1). */
function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r1:
        h = ((g1 - b1) / d + (g1 < b1 ? 6 : 0)) * 60;
        break;
      case g1:
        h = ((b1 - r1) / d + 2) * 60;
        break;
      case b1:
        h = ((r1 - g1) / d + 4) * 60;
        break;
    }
  }
  return [h, s, l];
}

/** Linear interpolation between two RGB tuples. */
function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------
// 5-color → 7-slot brand palette mapper
// ---------------------------------------------------------------------------

type Enriched = {
  hex: string;
  rgb: [number, number, number];
  hsl: [number, number, number];
  lum: number;
};

function enrich(hex: string): Enriched | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return { hex: hex.toUpperCase(), rgb, hsl: rgbToHsl(rgb), lum: luminance(rgb) };
}

/**
 * Heuristic — assumes the 5-color source is a "harmonised" set with no
 * explicit bg/text role. Picks bg = lightest, text = darkest, derives
 * surface + textMuted from those, then assigns the 3 most saturated
 * remaining colors to primary / secondary / accent in saturation order.
 *
 * The "Dark" buckets are detected later (by inspecting whether the lightest
 * color is itself dark, i.e. the whole palette skews dark — in which case
 * the same pick logic naturally produces a dark-mode brand palette).
 */
function mapToBrandPalette(source: readonly string[]): ColorPalette | null {
  const colors = source.map(enrich).filter((c): c is Enriched => c !== null);
  if (colors.length < 3) return null;

  const sortedByLum = [...colors].sort((a, b) => a.lum - b.lum);
  const text = sortedByLum[0];
  const background = sortedByLum[sortedByLum.length - 1];

  // Surface: a tone slightly off from background. Prefer the second-lightest
  // source color if it's clearly distinct; otherwise mix bg toward text by 6%.
  const secondLightest = sortedByLum[sortedByLum.length - 2];
  const surfaceRgb =
    secondLightest && Math.abs(secondLightest.lum - background.lum) > 0.04
      ? secondLightest.rgb
      : mixRgb(background.rgb, text.rgb, 0.06);

  // textMuted: 50% mix between text and bg (works for both light and dark themes).
  const textMutedRgb = mixRgb(text.rgb, background.rgb, 0.5);

  // Primary / secondary / accent: pick from the "middle" colors (excluding
  // the chosen bg + text), ranked by saturation.
  const usedHex = new Set([text.hex, background.hex]);
  const middles = colors.filter((c) => !usedHex.has(c.hex)).sort((a, b) => b.hsl[1] - a.hsl[1]);

  const primary = middles[0] ?? colors[0];
  const secondary = middles[1] ?? middles[0] ?? primary;
  const accent = middles[2] ?? middles[1] ?? secondary;

  return {
    primary: primary.hex,
    secondary: secondary.hex,
    accent: accent.hex,
    background: background.hex,
    surface: toHex(...surfaceRgb),
    text: text.hex,
    textMuted: toHex(...textMutedRgb),
  };
}

// ---------------------------------------------------------------------------
// Auto-categorisation
// ---------------------------------------------------------------------------

/** Smallest signed angular distance between two hues (0..180). */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function categorise(source: readonly string[]): PresetCategory {
  const enriched = source.map(enrich).filter((c): c is Enriched => c !== null);
  if (enriched.length === 0) return "muted";

  const sats = enriched.map((c) => c.hsl[1]);
  const lights = enriched.map((c) => c.hsl[2]);
  const hues = enriched.filter((c) => c.hsl[1] > 0.1).map((c) => c.hsl[0]);

  const avgSat = sats.reduce((s, n) => s + n, 0) / sats.length;
  const avgLight = lights.reduce((s, n) => s + n, 0) / lights.length;
  const bgLum = Math.max(...enriched.map((c) => c.lum));

  // Hue spread = max pairwise hue distance among saturated colors.
  let hueSpread = 0;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      hueSpread = Math.max(hueSpread, hueDist(hues[i], hues[j]));
    }
  }

  // Average hue (circular mean) — only used for warm/cool/earthy buckets.
  let sinSum = 0;
  let cosSum = 0;
  for (const h of hues) {
    sinSum += Math.sin((h * Math.PI) / 180);
    cosSum += Math.cos((h * Math.PI) / 180);
  }
  let avgHue = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
  if (avgHue < 0) avgHue += 360;

  // Priority order — first match wins. Picking the strongest signal first
  // keeps each palette in exactly one bucket.
  if (bgLum < 0.18) return "dark";
  if (avgSat < 0.18 || hueSpread < 25) return "mono";
  if (avgSat > 0.25 && avgLight > 0.72) return "pastel";
  if (avgSat > 0.62) return "vibrant";
  if (avgHue >= 20 && avgHue <= 50 && avgSat >= 0.3 && avgSat <= 0.65 && avgLight < 0.6)
    return "earthy";
  if ((avgHue <= 60 || avgHue >= 330) && avgSat > 0.3) return "warm";
  if (avgHue >= 180 && avgHue <= 270 && avgSat > 0.3) return "cool";
  return "muted";
}

// ---------------------------------------------------------------------------
// Featured (hand-picked) presets
// ---------------------------------------------------------------------------

/** Originals from the previous picker — kept for continuity. */
const FEATURED: ReadonlyArray<{
  id: string;
  label: string;
  swatch: readonly string[];
  palette: ColorPalette;
}> = [
  {
    id: "featured-bold",
    label: "Bold",
    swatch: ["#FF3B30", "#FF6B35", "#FFD60A", "#FFFFFF", "#1C1C1E"],
    palette: {
      primary: "#FF3B30",
      secondary: "#FF6B35",
      accent: "#FFD60A",
      background: "#FFFFFF",
      surface: "#F5F5F5",
      text: "#1C1C1E",
      textMuted: "#6C6C70",
    },
  },
  {
    id: "featured-minimal",
    label: "Minimal",
    swatch: ["#000000", "#333333", "#0066CC", "#FFFFFF", "#F2F2F7"],
    palette: {
      primary: "#000000",
      secondary: "#333333",
      accent: "#0066CC",
      background: "#FFFFFF",
      surface: "#F2F2F7",
      text: "#1C1C1E",
      textMuted: "#8E8E93",
    },
  },
  {
    id: "featured-playful",
    label: "Playful",
    swatch: ["#5E5CE6", "#FF6EAB", "#30D158", "#FFFFFF", "#F2F2F7"],
    palette: {
      primary: "#5E5CE6",
      secondary: "#FF6EAB",
      accent: "#30D158",
      background: "#FFFFFF",
      surface: "#F2F2F7",
      text: "#1C1C1E",
      textMuted: "#8E8E93",
    },
  },
  {
    id: "featured-technical",
    label: "Technical",
    swatch: ["#0A84FF", "#30D158", "#FF9F0A", "#000000", "#1C1C1E"],
    palette: {
      primary: "#0A84FF",
      secondary: "#30D158",
      accent: "#FF9F0A",
      background: "#000000",
      surface: "#1C1C1E",
      text: "#FFFFFF",
      textMuted: "#8E8E93",
    },
  },
];

// ---------------------------------------------------------------------------
// Build the categorised list — done once at module load.
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<PresetCategory, string> = {
  featured: "Featured",
  vibrant: "Vibrant",
  pastel: "Pastel",
  dark: "Dark",
  mono: "Mono",
  warm: "Warm",
  cool: "Cool",
  earthy: "Earthy",
  muted: "Muted",
};

const CATEGORY_ORDER: PresetCategory[] = [
  "featured",
  "vibrant",
  "pastel",
  "dark",
  "mono",
  "warm",
  "cool",
  "earthy",
  "muted",
];

function buildPresets(): {
  byId: Map<string, PalettePreset>;
  groups: CategoryGroup[];
} {
  const byCategory = new Map<PresetCategory, PalettePreset[]>();
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, []);

  // Helper to dodge the non-null-assertion lint while still trusting the
  // CATEGORY_ORDER seed loop above. Throws if a category somehow didn't seed.
  const bucket = (cat: PresetCategory): PalettePreset[] => {
    const list = byCategory.get(cat);
    if (!list) throw new Error(`palette-presets: missing bucket for ${cat}`);
    return list;
  };

  // Featured first, in fixed order.
  for (const f of FEATURED) {
    bucket("featured").push({
      id: f.id,
      label: `Featured · ${f.label}`,
      category: "featured",
      palette: f.palette,
      swatch: f.swatch,
    });
  }

  // Derived presets from the source JSON.
  const sources = sourcePalettes as readonly (readonly string[])[];
  let derivedIndex = 0;
  for (const src of sources) {
    const palette = mapToBrandPalette(src);
    if (!palette) continue;
    const cat = categorise(src);
    const list = bucket(cat);
    derivedIndex += 1;
    list.push({
      id: `${cat}-${derivedIndex}`,
      label: `${CATEGORY_LABELS[cat]} #${list.length + 1}`,
      category: cat,
      palette,
      swatch: src,
    });
  }

  const byId = new Map<string, PalettePreset>();
  const groups: CategoryGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const presets = byCategory.get(cat) ?? [];
    if (presets.length === 0) continue;
    for (const p of presets) byId.set(p.id, p);
    groups.push({ key: cat, label: CATEGORY_LABELS[cat], presets });
  }

  return { byId, groups };
}

const built = buildPresets();

/** Categorised groups in display order. Empty categories are omitted. */
export const PRESET_GROUPS: readonly CategoryGroup[] = built.groups;

/** O(1) lookup by preset id (used by `applyPreset`). */
export const PRESET_BY_ID: ReadonlyMap<string, PalettePreset> = built.byId;

/** Total number of presets, derived + featured. */
export const PRESET_COUNT: number = built.byId.size;
