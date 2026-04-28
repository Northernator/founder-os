/**
 * create-stitch-pack — emits the design-to-code prompt + config that
 * the founder feeds into Stitch / v0 / Figma Make to generate UI.
 *
 * pt.44 — now reads the Screens canvas (pt.43) + Spec canvas (pt.41)
 * when present, so the per-screen direction the founder spent the
 * Screens stage filling in actually flows downstream. Pre-pt.44 the
 * step hardcoded `screens: ["onboarding", "dashboard", "settings"]`
 * which gave Stitch nothing — the brief alone wasn't enough context
 * to produce useful UI for the founder's actual product.
 *
 * Design notes:
 *   - Best-effort canvas reads: missing or malformed canvases fall
 *     back to the legacy hardcoded screen list. The audit (pt.43h)
 *     already flags missing/invalid canvases at WIREFRAME_READY+;
 *     this step doesn't re-flag.
 *   - Skips on re-run: if `stitch-prompt.md` already exists, leaves
 *     the founder's hand-edits alone (same idempotence policy as
 *     ensure-spec / ensure-uk-setup). Re-running the pipeline doesn't
 *     overwrite a tweaked prompt.
 *   - The stitch-config.json is a richer JSON than the legacy version:
 *     it now carries per-screen objects (name, description, shellType,
 *     mappedFeatures[], mappedEntities[]) so downstream consumers can
 *     render screen-by-screen rather than infer.
 */
import { createLogger } from "@founder-os/logger";
import {
  getStitchDir,
  getScreensCanvasPath,
  getSpecCanvasPath,
} from "@founder-os/workspace-core";
import {
  ScreensCanvasSchema,
  ProductSpecCanvasSchema,
  SHELL_TYPE_DESCRIPTIONS,
  type Screen,
  type ShellType,
} from "@founder-os/domain";
import type { BrandBrief } from "@founder-os/branding-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-stitch-pack");

export type CreateStitchPackContext = {
  fs: Filesystem;
  ventureId: string;
  ventureRoot: string;
  brief: BrandBrief;
  appType: string;
};

/**
 * Per-screen shape baked into stitch-config.json. Stable contract for
 * downstream consumers (Stitch wrappers, v0 prompts, Figma Make
 * adapters). Use plain types not the domain `Screen` so adding fields
 * on the canvas-side doesn't accidentally widen the stitch contract.
 */
type StitchScreen = {
  name: string;
  description: string;
  shellType: ShellType | "DASHBOARD"; // narrowed default
  shellHint: string; // human-readable layout hint from SHELL_TYPE_DESCRIPTIONS
  mappedFeatures: string[];
  mappedEntities: string[];
  notes: string;
};

/** Legacy hardcoded fallback when no Screens canvas exists. */
const LEGACY_FALLBACK_SCREENS: StitchScreen[] = [
  {
    name: "Onboarding",
    description: "Welcome, signup, and first-run flow",
    shellType: "AUTH",
    shellHint: SHELL_TYPE_DESCRIPTIONS.AUTH,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Pre-pt.43 fallback — Screens canvas was missing or invalid.",
  },
  {
    name: "Dashboard",
    description: "Main workspace / home screen",
    shellType: "DASHBOARD",
    shellHint: SHELL_TYPE_DESCRIPTIONS.DASHBOARD,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Pre-pt.43 fallback — Screens canvas was missing or invalid.",
  },
  {
    name: "Settings",
    description: "User preferences, account, billing",
    shellType: "SETTINGS",
    shellHint: SHELL_TYPE_DESCRIPTIONS.SETTINGS,
    mappedFeatures: [],
    mappedEntities: [],
    notes: "Pre-pt.43 fallback — Screens canvas was missing or invalid.",
  },
];

export async function createStitchPackStep(
  ctx: CreateStitchPackContext
): Promise<{ status: string; producedArtifactIds: string[] }> {
  const stitchDir = getStitchDir(ctx.ventureRoot);
  await ctx.fs.mkdir(stitchDir);

  const markerPath = `${stitchDir}/stitch-prompt.md`;
  if (await ctx.fs.exists(markerPath)) {
    log.info("Stitch pack already exists, skipping");
    return { status: "skipped", producedArtifactIds: [] };
  }

  // Best-effort canvas reads. Both canvases are optional from this
  // step's POV — missing/malformed falls back to the legacy hardcoded
  // screens with a note. The audit step already flags
  // missing/malformed canvases at the appropriate stage.
  const screens = await loadScreensForStitch(ctx);

  const stitchPrompt = generateStitchPrompt(ctx, screens);
  await ctx.fs.writeFile(markerPath, stitchPrompt);

  // Stitch config — richer than pre-pt.44. Per-screen objects let
  // downstream Stitch wrappers / v0 / Figma Make adapters render
  // screen-by-screen with shellType direction.
  const stitchConfig = {
    ventureId: ctx.ventureId,
    appName: ctx.brief.companyName,
    appType: ctx.appType,
    theme: {
      primaryColor: ctx.brief.colorPalette.primary,
      fontFamily: ctx.brief.typography.bodyFont,
    },
    screens,
    generatedAt: new Date().toISOString(),
    schemaVersion: 2, // bumped at pt.44 — pre-pt.44 was implicit v1
  };
  await ctx.fs.writeFile(
    `${stitchDir}/stitch-config.json`,
    JSON.stringify(stitchConfig, null, 2)
  );

  log.info(
    `Stitch pack created at ${stitchDir} with ${screens.length} screen(s)`
  );
  return { status: "done", producedArtifactIds: [] };
}

/**
 * Load + transform the Screens canvas into the stitch-pack screen
 * shape. Falls back to LEGACY_FALLBACK_SCREENS when the canvas is
 * missing or malformed. Resolves featureIds / entityIds against the
 * spec canvas when present; falls back to raw ids otherwise.
 */
async function loadScreensForStitch(
  ctx: CreateStitchPackContext
): Promise<StitchScreen[]> {
  const screensCanvasPath = getScreensCanvasPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(screensCanvasPath))) {
    log.info(
      "No screens-canvas.json — using legacy fallback screen list. Run the pipeline through ensure-screens to populate."
    );
    return LEGACY_FALLBACK_SCREENS;
  }

  let canvasScreens: Screen[];
  try {
    const raw = await ctx.fs.readFile(screensCanvasPath);
    const parsed = ScreensCanvasSchema.parse(JSON.parse(raw));
    canvasScreens = parsed.screens.filter(
      (s) => s.name.trim().length > 0
    );
  } catch (err) {
    log.warn(
      `Screens canvas malformed (${err instanceof Error ? err.message : String(err)}) — using legacy fallback`
    );
    return LEGACY_FALLBACK_SCREENS;
  }

  if (canvasScreens.length === 0) {
    log.info("Screens canvas exists but has no named screens — using legacy fallback");
    return LEGACY_FALLBACK_SCREENS;
  }

  // Resolve feature/entity ids against the spec canvas. Best-effort —
  // missing/malformed spec just leaves raw ids in the output, which is
  // still useful to a human reader.
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

async function loadSpecIdMaps(ctx: CreateStitchPackContext): Promise<{
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

function generateStitchPrompt(
  ctx: CreateStitchPackContext,
  screens: StitchScreen[]
): string {
  const { brief, appType } = ctx;
  const screenSection = screens
    .map((s, idx) => {
      const lines: string[] = [];
      lines.push(`${idx + 1}. **${s.name}** — ${s.description || "(no description)"}`);
      lines.push(`   - Shell: \`${s.shellType}\` (${s.shellHint})`);
      if (s.mappedFeatures.length > 0) {
        lines.push(`   - Fulfills features: ${s.mappedFeatures.join(", ")}`);
      }
      if (s.mappedEntities.length > 0) {
        lines.push(`   - Touches entities: ${s.mappedEntities.join(", ")}`);
      }
      if (s.notes) {
        lines.push(`   - Notes: ${s.notes}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `# Stitch Export Prompt — ${brief.companyName}

## App Identity
- **Name**: ${brief.companyName}
- **Type**: ${appType}
- **Tagline**: ${brief.tagline}
- **Mission**: ${brief.mission}

## Design System
- **Primary colour**: ${brief.colorPalette.primary}
- **Secondary colour**: ${brief.colorPalette.secondary}
- **Accent**: ${brief.colorPalette.accent}
- **Background**: ${brief.colorPalette.background}
- **Heading font**: ${brief.typography.headingFont} (${brief.typography.headingWeight})
- **Body font**: ${brief.typography.bodyFont} (${brief.typography.bodyWeight})

## Personality
${brief.personality.map((p) => `- ${p}`).join("\n")}
**Tone**: ${brief.toneOfVoice}

## Screens to Generate

${screenSection}

## Design Constraints
- Mobile-first (375px base), desktop at 1440px
- WCAG AA contrast minimum
- Dark mode variant for each screen
- Follow ${brief.personality[0] ?? "minimal"} brand personality throughout
- Honour the shell type for each screen — DASHBOARD ≠ FORM ≠ EDITOR ≠ LIST_DETAIL. The shell hint describes the expected layout shape; structure each screen accordingly.

---
_Ready for Stitch AI / Figma Make / v0 / similar tools._
_Generated by Founder OS on ${new Date().toISOString()}_
_Schema version 2 (pt.44 — per-screen direction from Screens canvas)_
`;
}
