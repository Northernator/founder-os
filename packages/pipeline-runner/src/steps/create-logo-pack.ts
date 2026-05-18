/**
 * create-logo-pack.ts -- generates the brand logo pack via the active
 * LLM provider, asking it to output raw SVG markup.
 *
 * Subscription-friendly by design
 * --------------------------------
 * This step takes the same `OrchestratorLlmCaller` the brief step uses
 * and goes through whatever provider the host wired up (subscription-
 * preferred routing means Gemini-CLI / Claude-CLI / Codex on
 * subscription, falling back to HTTP if no subscription is active).
 *
 * The model is asked to return RAW SVG markup -- vector text, not a
 * raster image. No API key needed, no Imagen, no base64 transport.
 * The output quality is "good enough" for a v1 brand mark and far
 * better for downstream editability (Tailwind theme tokens, SVG
 * favicon, recolouring) than a static PNG would be.
 *
 * Prompts come from `@founder-os/branding-core/logo-svg-prompts` so
 * this step and the Brand chat panel's "/logo" command stay in
 * lockstep on archetype wording.
 *
 * Behaviour
 * ---------
 *  - 4 parallel calls, one per archetype:
 *      wordmark / lettermark / icon-wordmark / abstract-mark
 *  - Each successful call writes
 *      03_brand/logo/exports/logo-<archetype>.svg
 *  - The icon-wordmark variant is written ALSO as `logo.svg` (the
 *    primary marker file every downstream consumer reads). If
 *    icon-wordmark failed, the first non-empty variant gets promoted
 *    to primary.
 *  - Skip-if-exists at the marker path: if `logo.svg` already exists
 *    we return `status: "skipped"`. Re-runs are cheap -- delete the
 *    exports/ dir to force regeneration.
 *  - If ALL 4 variants come back empty, throw a clear error rather
 *    than write a half-empty pack.
 */
import {
  type LogoArchetype,
  type LogoPromptBrief,
  LOGO_ARCHETYPES,
  SYSTEM_PROMPT_SVG,
  buildArchetypePrompt,
  extractSvg,
} from "@founder-os/branding-core";
import type { BrandBrief } from "@founder-os/branding-core";
import { createLogger } from "@founder-os/logger";
import { getLogoExportsDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { OrchestratorLlmCaller } from "../orchestrator.js";

const log = createLogger("pipeline-runner:create-logo-pack");

export type CreateLogoPackContext = {
  fs: Filesystem;
  ventureId: string;
  ventureRoot: string;
  brief: BrandBrief;
  /**
   * LLM caller -- same shape as the brief step. The host (desktop /
   * seed / test) decides which provider routes here; subscription-mode
   * Gemini CLI is the default when configured, but any provider that
   * can produce SVG markup works.
   *
   * The brand-stage runner refuses to validate() when no caller is
   * available, so this step assumes it can call freely.
   */
  callLlm: OrchestratorLlmCaller;
  /**
   * Subset of archetypes to generate. Omit for all four. Useful when
   * the founder wants to iterate on just one (the Brand chat panel
   * exposes this via the `/logo <archetype>` slash command).
   */
  archetypes?: readonly LogoArchetype[];
};

export type CreateLogoPackResult = {
  status: "done" | "skipped" | "partial";
  producedArtifactIds: string[];
  /** Paths written, in write order. */
  writtenPaths: string[];
  /** Per-archetype outcome -- "ok" if SVG extracted, "empty" otherwise. */
  perArchetype: Record<LogoArchetype, "ok" | "empty">;
};

export async function createLogoPackStep(
  ctx: CreateLogoPackContext
): Promise<CreateLogoPackResult> {
  const exportsDir = getLogoExportsDir(ctx.ventureRoot);
  await ctx.fs.mkdir(exportsDir);

  const markerPath = `${exportsDir}/logo.svg`;
  if (await ctx.fs.exists(markerPath)) {
    log.info("Logo pack already exists, skipping");
    return {
      status: "skipped",
      producedArtifactIds: [],
      writtenPaths: [],
      perArchetype: emptyPerArchetype(),
    };
  }

  const archetypes: readonly LogoArchetype[] = ctx.archetypes ?? LOGO_ARCHETYPES;
  const promptBrief = briefToPromptShape(ctx.brief);

  log.info(`Generating ${archetypes.length} logo variant(s) via LLM (SVG)`);

  // Fire all archetype calls in parallel. Per-call failures are
  // captured rather than thrown -- if 3 of 4 succeed the founder
  // still gets a useful pack, and the result.status reflects partial.
  const results = await Promise.all(
    archetypes.map(async (archetype) => {
      try {
        const raw = await ctx.callLlm({
          system: SYSTEM_PROMPT_SVG,
          user: buildArchetypePrompt(promptBrief, archetype),
        });
        const svg = extractSvg(raw);
        return { archetype, svg, error: undefined as string | undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { archetype, svg: "", error: message };
      }
    })
  );

  const writtenPaths: string[] = [];
  const perArchetype: Record<LogoArchetype, "ok" | "empty"> = emptyPerArchetype();

  for (const r of results) {
    if (r.svg) {
      const filename = `logo-${r.archetype}.svg`;
      const target = `${exportsDir}/${filename}`;
      await ctx.fs.writeFile(target, r.svg);
      log.info(`Wrote ${filename} -> ${target}`);
      writtenPaths.push(target);
      perArchetype[r.archetype] = "ok";
    } else {
      log.warn(`Archetype ${r.archetype} returned no SVG`, { error: r.error });
      perArchetype[r.archetype] = "empty";
    }
  }

  // Pick the primary that becomes logo.svg. Preference order: the
  // brief logoSpec style (mapped to an archetype) first, then
  // icon-wordmark, then any non-empty variant.
  const primary = pickPrimaryArchetype(ctx.brief, perArchetype);
  if (!primary) {
    throw new Error(
      `Logo pack: all ${archetypes.length} archetype call(s) returned empty SVG for venture ${ctx.ventureId}. Check that the LLM provider is responsive and supports SVG output.`
    );
  }

  // Copy the primary into logo.svg -- duplicated content but every
  // downstream consumer reads logo.svg so we materialise it.
  const primaryResult = results.find((r) => r.archetype === primary);
  if (!primaryResult || !primaryResult.svg) {
    throw new Error(`Logo pack: primary archetype ${primary} lost between pick and write`);
  }
  await ctx.fs.writeFile(markerPath, primaryResult.svg);
  log.info(`Wrote primary logo (${primary}) -> ${markerPath}`);
  writtenPaths.push(markerPath);

  const successCount = Object.values(perArchetype).filter((v) => v === "ok").length;
  const status: "done" | "partial" =
    successCount === archetypes.length ? "done" : "partial";
  log.info(`Logo pack materialized at ${exportsDir}`, {
    status,
    primary,
    okCount: successCount,
    totalRequested: archetypes.length,
  });
  return { status, producedArtifactIds: [], writtenPaths, perArchetype };
}

/**
 * Map the brief logoSpec.style to an archetype. The brief schema's
 * enum ("wordmark" / "lettermark" / "icon+wordmark" / "abstract") is
 * close to but not identical to LogoArchetype ("icon-wordmark" vs
 * "icon+wordmark", "abstract-mark" vs "abstract"), so we map.
 */
function styleToArchetype(style: BrandBrief["logoSpec"]["style"]): LogoArchetype {
  switch (style) {
    case "wordmark":
      return "wordmark";
    case "lettermark":
      return "lettermark";
    case "icon+wordmark":
      return "icon-wordmark";
    case "abstract":
      return "abstract-mark";
  }
}

function pickPrimaryArchetype(
  brief: BrandBrief,
  per: Record<LogoArchetype, "ok" | "empty">
): LogoArchetype | null {
  const briefPick = styleToArchetype(brief.logoSpec.style);
  if (per[briefPick] === "ok") return briefPick;
  if (per["icon-wordmark"] === "ok") return "icon-wordmark";
  for (const a of LOGO_ARCHETYPES) {
    if (per[a] === "ok") return a;
  }
  return null;
}

function emptyPerArchetype(): Record<LogoArchetype, "ok" | "empty"> {
  return {
    wordmark: "empty",
    lettermark: "empty",
    "icon-wordmark": "empty",
    "abstract-mark": "empty",
  };
}

function briefToPromptShape(brief: BrandBrief): LogoPromptBrief {
  return {
    companyName: brief.companyName,
    tagline: brief.tagline,
    toneOfVoice: brief.toneOfVoice,
    targetAudience: brief.targetAudience,
    personality: brief.personality,
    palette: {
      primary: brief.colorPalette.primary,
      secondary: brief.colorPalette.secondary,
      accent: brief.colorPalette.accent,
      text: brief.colorPalette.text,
      background: brief.colorPalette.background,
    },
  };
}
