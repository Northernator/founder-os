import type { BrandBrief } from "@founder-os/branding-core";
import {
  ProductSpecCanvasSchema,
  SHELL_TYPE_DESCRIPTIONS,
  type Screen,
  ScreensCanvasSchema,
  type ShellType,
} from "@founder-os/domain";
import type {
  DesignTokens,
  HandoffExport,
  SliderParam,
} from "@founder-os/handoff-contract";
import { createLogger } from "@founder-os/logger";
import { getScreensCanvasPath, getSpecCanvasPath, getStitchDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

/**
 * create-codesign-pack — emits a CoDesign-shaped HandoffExport for the
 * HANDOFF stage. Parallel to create-stitch-pack but populates `html` +
 * `parameters` directly (no external prompt round-trip), matching what
 * Open CoDesign's parametric output looks like.
 *
 * STATUS — Stub provider:
 *   Open CoDesign currently ships as a desktop Electron app
 *   (brew/scoop/winget) with no documented CLI. Until it exposes a
 *   headless `codesign generate --brief X --out Y` surface, this step
 *   produces a deterministic stub: a semantic-HTML scaffold built from
 *   the Screens canvas + brand brief, plus parametric sliders derived
 *   from the brand palette/typography. The shape matches the CoDesign
 *   contract so slice 7 (BUILD adoption) can consume it without
 *   depending on the real tool being installed.
 *
 *   When CoDesign exposes a CLI, replace `generateStubExport(...)`
 *   with a child-process spawn that pipes the brief in and parses the
 *   tool's HandoffExport-shaped output. The HandoffStageRunner contract
 *   does not change.
 *
 * Idempotent: skips if `${stitchDir}/handoff-export.json` already exists.
 * Re-running won't overwrite a hand-tuned export.
 */
const log = createLogger("pipeline-runner:create-codesign-pack");

export type CreateCodesignPackContext = {
  fs: Filesystem;
  ventureId: string;
  ventureRoot: string;
  brief: BrandBrief;
  appType: string;
};

type CodesignScreen = {
  name: string;
  description: string;
  shellType: ShellType | "DASHBOARD";
  shellHint: string;
  mappedFeatures: string[];
  mappedEntities: string[];
  notes: string;
};

const LEGACY_FALLBACK_SCREENS: CodesignScreen[] = [
  {
    name: "Onboarding",
    description: "Welcome, signup, and first-run flow",
    shellType: "AUTH",
    shellHint: SHELL_TYPE_DESCRIPTIONS.AUTH,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Fallback — Screens canvas missing.",
  },
  {
    name: "Dashboard",
    description: "Main workspace / home screen",
    shellType: "DASHBOARD",
    shellHint: SHELL_TYPE_DESCRIPTIONS.DASHBOARD,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Fallback — Screens canvas missing.",
  },
  {
    name: "Settings",
    description: "User preferences, account, billing",
    shellType: "SETTINGS",
    shellHint: SHELL_TYPE_DESCRIPTIONS.SETTINGS,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Fallback — Screens canvas missing.",
  },
];

export async function createCodesignPackStep(
  ctx: CreateCodesignPackContext
): Promise<{ status: string; producedArtifactIds: string[] }> {
  const stitchDir = getStitchDir(ctx.ventureRoot);
  await ctx.fs.mkdir(stitchDir);

  const exportPath = `${stitchDir}/handoff-export.json`;
  if (await ctx.fs.exists(exportPath)) {
    log.info("CoDesign handoff-export already exists, skipping");
    return { status: "skipped", producedArtifactIds: [] };
  }

  const screens = await loadScreensForCodesign(ctx);
  const handoffExport = generateStubExport(ctx, screens);

  await ctx.fs.writeFile(exportPath, JSON.stringify(handoffExport, null, 2));

  log.info(
    `CoDesign pack created at ${exportPath} with ${screens.length} screen(s) and ${
      Object.keys(handoffExport.parameters ?? {}).length
    } parameter(s)`
  );
  return { status: "done", producedArtifactIds: [] };
}

/**
 * Build the HandoffExport. Pure function — no I/O. Easy to unit-test
 * and easy to swap when the real CoDesign CLI lands.
 */
function generateStubExport(
  ctx: CreateCodesignPackContext,
  screens: CodesignScreen[]
): HandoffExport {
  const tokens = extractDesignTokens(ctx.brief);
  return {
    source: "codesign",
    schemaVersion: 1,
    html: generateStubHtml(ctx, screens, tokens),
    parameters: generateStubParameters(ctx.brief),
    tokens,
    generatedAt: new Date().toISOString(),
    providerVersion: "codesign-stub@0.1",
    notes: `Stub CoDesign output -- ${screens.length} screen(s). Replace generateStubExport() with a real codesign CLI spawn when the tool exposes a headless surface.`,
  };
}

/**
 * Parametric sliders modelled on what Open CoDesign emits after
 * generation -- one slider per knob worth tuning. The stub exposes:
 *   - 4 color sliders for the brand palette
 *   - 1 numeric slider for body font weight
 *   - 1 numeric slider for heading font weight
 *   - 1 numeric slider for spacing-base (8-16px)
 *   - 1 numeric slider for radius-base (0-24px)
 *
 * The cssVar names are conventional design-token strings BUILD can
 * splice into a generated CSS file.
 */
function generateStubParameters(brief: BrandBrief): Record<string, SliderParam> {
  return {
    colorPrimary: {
      label: "Primary",
      description: "Brand primary -- buttons, links, focus rings.",
      type: "color",
      value: brief.colorPalette.primary,
      cssVar: "--color-primary",
    },
    colorSecondary: {
      label: "Secondary",
      description: "Supporting accents and chips.",
      type: "color",
      value: brief.colorPalette.secondary,
      cssVar: "--color-secondary",
    },
    colorAccent: {
      label: "Accent",
      description: "High-emphasis highlights.",
      type: "color",
      value: brief.colorPalette.accent,
      cssVar: "--color-accent",
    },
    colorBackground: {
      label: "Background",
      description: "Page background.",
      type: "color",
      value: brief.colorPalette.background,
      cssVar: "--color-bg",
    },
    headingWeight: {
      label: "Heading weight",
      description: "Font-weight for headings.",
      type: "number",
      value: brief.typography.headingWeight,
      min: 300,
      max: 900,
      step: 100,
      cssVar: "--font-weight-heading",
    },
    bodyWeight: {
      label: "Body weight",
      description: "Font-weight for body copy.",
      type: "number",
      value: brief.typography.bodyWeight,
      min: 300,
      max: 700,
      step: 100,
      cssVar: "--font-weight-body",
    },
    spacingBase: {
      label: "Spacing base",
      description: "Base unit for the spacing scale (px).",
      type: "number",
      value: 8,
      min: 4,
      max: 16,
      step: 2,
      cssVar: "--space-base",
    },
    radiusBase: {
      label: "Corner radius",
      description: "Default corner radius (px).",
      type: "number",
      value: 8,
      min: 0,
      max: 24,
      step: 2,
      cssVar: "--radius-base",
    },
  };
}

/**
 * Extract DesignTokens from a BrandBrief. Mirrored from
 * create-stitch-pack so both providers surface the same token shape.
 * Could be hoisted to a shared util in a follow-up slice.
 */
function extractDesignTokens(brief: BrandBrief): DesignTokens {
  return {
    colors: {
      primary: brief.colorPalette.primary,
      secondary: brief.colorPalette.secondary,
      accent: brief.colorPalette.accent,
      background: brief.colorPalette.background,
      surface: brief.colorPalette.surface,
      text: brief.colorPalette.text,
      textMuted: brief.colorPalette.textMuted,
    },
    typography: {
      fontFamily: brief.typography.bodyFont,
      scale: {
        heading: brief.typography.headingFont,
        headingWeight: brief.typography.headingWeight,
        body: brief.typography.bodyFont,
        bodyWeight: brief.typography.bodyWeight,
      },
    },
  };
}

/**
 * Build a single-page semantic-HTML scaffold, one section per screen,
 * driven by CSS variables that match the SliderParam.cssVar names so
 * BUILD can wire the sliders into live CSS without re-mapping.
 */
function generateStubHtml(
  ctx: CreateCodesignPackContext,
  screens: CodesignScreen[],
  tokens: DesignTokens
): string {
  const palette = tokens.colors ?? {};
  const sections = screens
    .map(
      (s) => `    <section class="screen" data-shell="${escapeAttr(s.shellType)}">
      <h2>${escapeHtml(s.name)}</h2>
      <p class="lede">${escapeHtml(s.description || "")}</p>
      ${
        s.mappedFeatures.length > 0
          ? `<p class="features">Features: ${s.mappedFeatures.map(escapeHtml).join(", ")}</p>`
          : ""
      }
      ${
        s.mappedEntities.length > 0
          ? `<p class="entities">Entities: ${s.mappedEntities.map(escapeHtml).join(", ")}</p>`
          : ""
      }
      ${s.notes ? `<aside class="notes">${escapeHtml(s.notes)}</aside>` : ""}
    </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(ctx.brief.companyName)} — Prototype</title>
  <style>
    :root {
      --color-primary: ${palette.primary ?? "#000"};
      --color-secondary: ${palette.secondary ?? "#666"};
      --color-accent: ${palette.accent ?? "#0af"};
      --color-bg: ${palette.background ?? "#fff"};
      --color-surface: ${palette.surface ?? "#f4f4f5"};
      --color-text: ${palette.text ?? "#111"};
      --color-text-muted: ${palette.textMuted ?? "#666"};
      --font-weight-heading: ${ctx.brief.typography.headingWeight};
      --font-weight-body: ${ctx.brief.typography.bodyWeight};
      --space-base: 8px;
      --radius-base: 8px;
      --font-family: ${ctx.brief.typography.bodyFont}, system-ui, sans-serif;
    }
    body { margin: 0; padding: calc(var(--space-base) * 4); background: var(--color-bg); color: var(--color-text); font-family: var(--font-family); font-weight: var(--font-weight-body); }
    h1, h2 { font-weight: var(--font-weight-heading); margin: 0 0 var(--space-base) 0; }
    .screen { background: var(--color-surface); border-radius: var(--radius-base); padding: calc(var(--space-base) * 3); margin-bottom: calc(var(--space-base) * 2); }
    .lede { color: var(--color-text-muted); margin: 0 0 var(--space-base) 0; }
    .features, .entities { font-size: 0.9em; color: var(--color-secondary); }
    .notes { font-size: 0.85em; padding: var(--space-base); background: var(--color-bg); border-left: 3px solid var(--color-accent); margin-top: var(--space-base); }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(ctx.brief.companyName)}</h1>
    <p class="lede">${escapeHtml(ctx.brief.tagline)}</p>
  </header>
  <main>
${sections}
  </main>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

// --- Screens canvas loading (mirrors create-stitch-pack) ----------------
async function loadScreensForCodesign(ctx: CreateCodesignPackContext): Promise<CodesignScreen[]> {
  const screensCanvasPath = getScreensCanvasPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(screensCanvasPath))) {
    log.info("No screens-canvas.json -- using legacy fallback for codesign pack");
    return LEGACY_FALLBACK_SCREENS;
  }

  let canvasScreens: Screen[];
  try {
    const raw = await ctx.fs.readFile(screensCanvasPath);
    const parsed = ScreensCanvasSchema.parse(JSON.parse(raw));
    canvasScreens = parsed.screens.filter((s) => s.name.trim().length > 0);
  } catch (err) {
    log.warn(
      `Screens canvas malformed (${err instanceof Error ? err.message : String(err)}) -- using legacy fallback`
    );
    return LEGACY_FALLBACK_SCREENS;
  }

  if (canvasScreens.length === 0) {
    log.info("Screens canvas exists but has no named screens -- using legacy fallback");
    return LEGACY_FALLBACK_SCREENS;
  }

  const idMaps = await loadSpecIdMaps(ctx);
  return canvasScreens.map((s) => ({
    name: s.name.trim(),
    description: s.description.trim(),
    shellType: s.shellType,
    shellHint: SHELL_TYPE_DESCRIPTIONS[s.shellType] ?? "",
    mappedFeatures: s.featureIds
      .map((id) => idMaps.features.get(id) ?? id)
      .filter((label) => label.trim().length > 0),
    mappedEntities: s.entityIds
      .map((id) => idMaps.entities.get(id) ?? id)
      .filter((label) => label.trim().length > 0),
    notes: s.notes.trim(),
  }));
}

async function loadSpecIdMaps(ctx: CreateCodesignPackContext): Promise<{
  features: Map<string, string>;
  entities: Map<string, string>;
}> {
  const features = new Map<string, string>();
  const entities = new Map<string, string>();
  const specPath = getSpecCanvasPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(specPath))) {
    return { features, entities };
  }
  try {
    const raw = await ctx.fs.readFile(specPath);
    const parsed = ProductSpecCanvasSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { features, entities };
    for (const f of parsed.data.features) {
      if (f.name.trim()) features.set(f.id, f.name.trim());
    }
    for (const e of parsed.data.dataModel.entities) {
      if (e.name.trim()) entities.set(e.id, e.name.trim());
    }
  } catch {
    // Spec audit already flags this; suppress here.
  }
  return { features, entities };
}
