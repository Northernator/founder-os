/**
 * Storyboard step -- shapes a MediaScript into per-shot Storyboard
 * entries the render step can dispatch.
 *
 * Inputs
 * ------
 *  - manifest:    venture.yaml
 *  - ventureRoot: absolute folder
 *  - fs:          injected Filesystem
 *  - script:      MediaScript from createMediaScriptStep (passed in
 *                 directly so this step does not re-read disk; the
 *                 runner orchestrates).
 *
 * Outputs (under 10_media/storyboards/)
 * -------------------------------------
 *  - storyboard.json -- structured Storyboard (zod schema in media-core)
 *
 * Behaviour
 * ---------
 *  - Slice 4 keeps it 1:1 (one shot per scene). Multi-shot scenes are
 *    a slice 5 follow-up driven by visualBrief keywords.
 *  - engineHint defaults to "auto" so the resolver can pick per-shot
 *    based on tier list + visualBrief keywords. The render step
 *    consumes media-core's resolveShotEngine() to decide.
 *  - heroTimestamps default to [durationSec/2] -- one inspect/snapshot
 *    sample at the midpoint. Empty array opts out of layout inspect.
 *  - No LLM dependency. Storyboard generation is deterministic so
 *    re-running yields identical output.
 */
import type { VentureManifest } from "@founder-os/domain";
import type {
  MediaEngine,
  MediaScript,
  Shot,
  Storyboard,
} from "@founder-os/media-core";
import type { Filesystem } from "../fs.js";
import {
  getMediaStoryboardsDir,
  getStoryboardJsonPath,
} from "@founder-os/workspace-core";

export type CreateStoryboardContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  script: MediaScript;
  /**
   * Optional per-venture override of the default engineHint. Defaults
   * to "auto" (resolver picks). Pin to "hyperframes" or "gemini_flow"
   * for ventures whose pipeline.media config says so.
   */
  defaultEngineHint?: MediaEngine;
  runId?: string;
};

export type CreateStoryboardResult = {
  status: "done";
  jsonPath: string;
  storyboard: Storyboard;
  shotCount: number;
};

/**
 * Pick a sensible engineHint from a scene's visualBrief. Used when
 * defaultEngineHint is "auto" (so the resolver still decides at
 * dispatch time, but we record the heuristic suggestion alongside).
 *
 * Returning "auto" means "let the resolver choose". Returning a
 * specific engine means "this shot is intentionally pinned".
 */
function deriveEngineHint(visualBrief: string): MediaEngine {
  const lower = visualBrief.toLowerCase();
  // Title cards, slides, kinetic typography, charts, UI demos -- all
  // structured/data-driven content -- are HyperFrames sweet spot.
  if (/title|slide|chart|metric|ui|product|launch|reveal|kinetic|typography/.test(lower)) {
    return "hyperframes";
  }
  // Founder cameo, b-roll, cinematic shots need an AI engine. Mark
  // "auto" so the resolver picks the first available AI tier
  // (wan2 / cogvideox / gemini_flow).
  if (/cameo|founder|story|cinematic|b-roll|broll|footage|scene/.test(lower)) {
    return "auto";
  }
  return "auto";
}

function buildShotForScene(
  sceneId: string,
  durationSec: number,
  prompt: string,
  visualBrief: string,
  defaultHint: MediaEngine,
): Shot {
  const hint =
    defaultHint === "auto" ? deriveEngineHint(visualBrief) : defaultHint;
  const heroMid = Math.max(0, Math.round((durationSec / 2) * 10) / 10);
  return {
    sceneId,
    engineHint: hint,
    prompt,
    heroTimestamps: [heroMid],
    durationSec,
    fps: 30,
    qualityPreset: "standard",
  };
}

export async function createStoryboardStep(
  ctx: CreateStoryboardContext,
): Promise<CreateStoryboardResult> {
  await ctx.fs.mkdir(getMediaStoryboardsDir(ctx.ventureRoot));

  const defaultHint = ctx.defaultEngineHint ?? "auto";
  const shots: Shot[] = ctx.script.scenes.map((scene) => {
    // Prompt = onScreen + voiceover + visualBrief, ordered most-specific-first
    // so AI engines get the headline before the supporting copy.
    const lines: string[] = [];
    if (scene.onScreen) lines.push(scene.onScreen);
    if (scene.voiceover) lines.push(scene.voiceover);
    lines.push(scene.visualBrief);
    const prompt = lines.join(" -- ");
    return buildShotForScene(scene.id, scene.durationSec, prompt, scene.visualBrief, defaultHint);
  });

  const storyboard: Storyboard = {
    schemaVersion: 1,
    scriptId: `${ctx.manifest.slug}-${ctx.runId ?? "no-run"}`,
    ventureSlug: ctx.manifest.slug,
    shots,
    generatedAt: new Date().toISOString(),
  };

  const jsonPath = getStoryboardJsonPath(ctx.ventureRoot);
  await ctx.fs.writeFile(jsonPath, `${JSON.stringify(storyboard, null, 2)}\n`);

  return {
    status: "done",
    jsonPath,
    storyboard,
    shotCount: shots.length,
  };
}
