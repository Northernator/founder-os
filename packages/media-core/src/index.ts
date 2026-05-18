// @founder-os/media-core -- contract for the MEDIA_READY pipeline stage.
//
// Slice 1: types + zod schemas + parse helpers + preset constants only.
// No provider implementations, no subprocess code -- those live in a future
// slice (and likely a sister package once HyperFrames + flow-prompts paths
// settle). See bizBuild/MEDIA-MODULE-SPEC.md for the design.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Engines + tier ordering
// ---------------------------------------------------------------------------

/**
 * Render engines the pipeline knows how to dispatch to. "auto" lets the
 * resolver pick per-shot based on the engineHint and venture config; the
 * other values pin a specific engine.
 */
export const MediaEngineSchema = z.enum([
  "hyperframes", // tier_0 -- HTML -> MP4, free, deterministic
  "wan2",        // tier_1 -- local AI render (RTX 4090 class)
  "cogvideox",   // tier_2 -- local AI render (lower spec)
  "gemini_flow", // tier_3 -- manual paste-in via subscription
  "gemini_api",  // tier_4 -- programmatic Veo, paid, opt-in
  "auto",        // resolver chooses based on tier list + shot signal
]);
export type MediaEngine = z.infer<typeof MediaEngineSchema>;

/**
 * Default tier order for new ventures. gemini_api is intentionally absent --
 * opt-in only, finance-capped. Override per venture in venture.yaml under
 * media.engineTiers.
 */
export const PROVIDER_TIERS_DEFAULT: ReadonlyArray<MediaEngine> = [
  "hyperframes",
  "wan2",
  "cogvideox",
  "gemini_flow",
];

// ---------------------------------------------------------------------------
// Intents + script
// ---------------------------------------------------------------------------

export const MediaIntentSchema = z.enum([
  "IDEA_TO_VIDEO",   // pulls from dev-brief + positioning
  "SCRIPT_TO_VIDEO", // pulls from existing copy / content artifacts
  "AUTO_CAMEO",      // uses founder reference photo
]);
export type MediaIntent = z.infer<typeof MediaIntentSchema>;

/**
 * One shot in a Scene's optional shotPlan. Each entry carries a full
 * per-shot prompt + duration; the storyboard step fans these out into
 * concrete Shots when scene.shotPlan is populated.
 *
 * Slice 7 lets the script LLM optionally return shotPlan per scene so
 * longer reels can break a 10-second 'product demo' scene into a wide
 * shot + a close-up + a UI focus, each rendered separately and stitched
 * in array order. When scene.shotPlan is undefined, the storyboard step
 * falls back to the 1:1 scene-to-shot mapping (the slice-4 behavior).
 */
export const ShotPlanEntrySchema = z.object({
  prompt: z.string(),
  durationSec: z.number().positive(),
});
export type ShotPlanEntry = z.infer<typeof ShotPlanEntrySchema>;

/**
 * One scene in a MediaScript -- the human-readable intent for a slice of
 * the final reel. Storyboards are built FROM these (one scene -> one or
 * more shots).
 */
export const SceneSchema = z.object({
  id: z.string(),
  durationSec: z.number().positive(),
  voiceover: z.string().optional(),
  onScreen: z.string().optional(),  // text overlay copy
  visualBrief: z.string(),          // human description that the resolver
                                    // reads to pick an engineHint when
                                    // engineHint = "auto"
  /**
   * Optional multi-shot plan (slice 7 of media arc). When present, the
   * storyboard step emits one Shot per entry; when absent, the scene
   * maps to a single Shot (slice-4 behavior).
   *
   * Populated by the script step's LLM-aware path when the model decides
   * a scene benefits from multiple visual angles. Sum of entry
   * durationSec should approximately equal scene.durationSec; the schema
   * does not enforce exact equality since LLMs are imprecise.
   */
  shotPlan: z.array(ShotPlanEntrySchema).optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const MediaScriptSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ventureSlug: z.string(),
  intent: MediaIntentSchema,
  scenes: z.array(SceneSchema),
  generatedAt: z.string(),
});
export type MediaScript = z.infer<typeof MediaScriptSchema>;

// ---------------------------------------------------------------------------
// Storyboard + shots
// ---------------------------------------------------------------------------

/**
 * Per-shot quality preset, mapped 1:1 to HyperFrames `--quality`. AI engines
 * also accept this string to pick an internal preset.
 */
export const QualityPresetSchema = z.enum(["draft", "standard", "high"]);
export type QualityPreset = z.infer<typeof QualityPresetSchema>;

export const FpsSchema = z.union([
  z.literal(24),
  z.literal(30),
  z.literal(60),
]);
export type Fps = z.infer<typeof FpsSchema>;

/**
 * One shot in a Storyboard. Engine-agnostic by design: the same shot shape
 * is consumed by every provider. HyperFrames reads `variables` +
 * `compositionId`; AI engines read `prompt` + `referenceFrames`; the manual
 * gemini_flow path writes `prompt` to flow-prompts.md for the user to paste
 * into Flow.
 */
export const ShotSchema = z.object({
  sceneId: z.string(),
  engineHint: MediaEngineSchema,
  // Canonical engine-agnostic prompt. AI engines render this directly;
  // gemini_flow writes it to flow-prompts.md.
  prompt: z.string(),
  // HyperFrames `--variables` payload. The composition declares its
  // schema via data-composition-variables; the runner passes this through
  // verbatim with --strict-variables, so a key mismatch fails the render.
  variables: z.record(z.unknown()).optional(),
  // HyperFrames composition id (template) to render. Maps to a file
  // under the project's compositions/ directory.
  compositionId: z.string().optional(),
  // Timestamps in seconds for snapshot --at (review gates) and
  // inspect --at (pre-render layout check).
  heroTimestamps: z.array(z.number().nonnegative()).optional(),
  // Reference images for AI engines (style refs, character refs, etc).
  referenceFrames: z.array(z.string()).optional(),
  durationSec: z.number().positive(),
  fps: FpsSchema.optional(),
  qualityPreset: QualityPresetSchema.optional(),
  // When true, HyperFrames runs under --docker for cross-machine
  // reproducibility. Slower but bit-identical. Off by default.
  deterministic: z.boolean().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const StoryboardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  scriptId: z.string(),
  ventureSlug: z.string(),
  shots: z.array(ShotSchema),
  generatedAt: z.string(),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// Provider interface (consumed by media-runner / stage-runners)
// ---------------------------------------------------------------------------

export interface MediaRenderResult {
  /** Absolute path to the rendered file (mp4/webm/mov/png-sequence dir). */
  path: string;
  /** Final duration, in seconds, as recorded after render. */
  durationSec: number;
  /** Engine that produced the render -- useful when "auto" was requested. */
  engine: MediaEngine;
  /** Free-form provider diagnostics, e.g. ffmpeg version, render time. */
  meta?: Record<string, unknown>;
}

/**
 * Provider contract. Implementations live outside this contract package so
 * media-core stays pure (no subprocess spawn, no fs work, no Node-only deps).
 */
export interface MediaProvider {
  readonly name: MediaEngine;
  /** Cheap probe -- e.g. `hyperframes doctor --json` exits 0. Cached per run. */
  available(): Promise<boolean>;
  /** Render a single shot. The output path is the runner's responsibility. */
  render(shot: Shot, outDir: string): Promise<MediaRenderResult>;
}

/**
 * Context the resolver needs to pick an engine for a shot tagged
 * engineHint = "auto". Kept narrow so media-core has zero runtime deps.
 */
export interface MediaResolverContext {
  /** Tier list for this venture (ordered, first-available wins). */
  tiers: ReadonlyArray<MediaEngine>;
  /** Probed availability per engine -- cached per run. */
  available: ReadonlySet<MediaEngine>;
}

// ---------------------------------------------------------------------------
// Finance tie-in
// ---------------------------------------------------------------------------

/**
 * Per-venture media spend cap. Only tier_4 (gemini_api) counts against this
 * -- tier_0..tier_3 are free or subscription-covered.
 */
export const MediaSpendSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ventureSlug: z.string(),
  capUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative().default(0),
  // ISO timestamps for visibility; the runner reads/writes these atomically.
  capSetAt: z.string(),
  lastSpendAt: z.string().optional(),
});
export type MediaSpend = z.infer<typeof MediaSpendSchema>;

// ---------------------------------------------------------------------------
// Per-venture media config (slice 8 of media arc)
// ---------------------------------------------------------------------------

/**
 * Per-venture media configuration -- lives at `manifest.media` in
 * venture.yaml. Slice 8 ships a single optional field: which engines
 * this venture has opted in to. The helper translates the list into
 * actual MediaProvider instances passed to MediaStageRunner.
 *
 * When absent, the helper applies a sensible default of
 * `["hyperframes", "gemini_flow"]` -- the two real paths that ship
 * out of the box. Stubs (wan2 / cogvideox / gemini_api) require
 * explicit opt-in via this field.
 */
export const MediaConfigSchema = z.object({
  enabledEngines: z.array(MediaEngineSchema).optional(),
});
export type MediaConfig = z.infer<typeof MediaConfigSchema>;

// ---------------------------------------------------------------------------
// HyperFrames template-project preset (see MEDIA-MODULE-SPEC.md sec 12)
// ---------------------------------------------------------------------------

/**
 * Blocks installed on every venture's HyperFrames project. These are the
 * neutral building primitives the agent can reach for without first
 * discovering the catalog.
 */
export const PRESET_CORE_BLOCKS: ReadonlyArray<string> = [
  "data-chart",
  "logo-outro",
  "flowchart",
  "vfx-text-cursor",
  "app-showcase",
  "ui-3d-reveal",
  "flash-through-white",
];

/** Components installed on every venture (small, additive). */
export const PRESET_CORE_COMPONENTS: ReadonlyArray<string> = [
  "grain-overlay",
  "shimmer-sweep",
  "grid-pixelate-wipe",
];

/**
 * Social-channel-specific overlays. Resolver installs the entry whose key
 * matches an enabled channel in venture.yaml under launch.channels.
 * macos-notification is always installed because it's used as a generic
 * call-to-action overlay regardless of channel.
 */
export const PRESET_SOCIAL_PACK: Readonly<Record<string, string>> = {
  youtube: "yt-lower-third",
  instagram: "instagram-follow",
  tiktok: "tiktok-follow",
  x: "x-post",
  twitter: "x-post",
};

export const PRESET_SOCIAL_ALWAYS: ReadonlyArray<string> = [
  "macos-notification",
];

/**
 * Heavy or experimental blocks. Off by default; gated behind
 * media.experimental = true in venture.yaml.
 */
export const PRESET_EXPERIMENTAL: ReadonlyArray<string> = [
  "vfx-iphone-device", // ships ~tens of MB of GLTF assets
  "vfx-magnetic",      // labelled experimental upstream
  "texture-mask-text", // 66 PBR luminance masks
];

// ---------------------------------------------------------------------------
// Parse helpers (the whole point of this package)
// ---------------------------------------------------------------------------

export function parseMediaScript(raw: unknown): MediaScript {
  return MediaScriptSchema.parse(raw);
}
export function safeParseMediaScript(raw: unknown) {
  return MediaScriptSchema.safeParse(raw);
}

export function parseStoryboard(raw: unknown): Storyboard {
  return StoryboardSchema.parse(raw);
}
export function safeParseStoryboard(raw: unknown) {
  return StoryboardSchema.safeParse(raw);
}

export function parseMediaSpend(raw: unknown): MediaSpend {
  return MediaSpendSchema.parse(raw);
}
export function safeParseMediaSpend(raw: unknown) {
  return MediaSpendSchema.safeParse(raw);
}

/**
 * Resolve a shot's effective engine from its hint + the venture's tier
 * list + which engines are currently available. Pure function -- no I/O.
 *
 * Behavior:
 *   - Pinned hint (not "auto"): return it if available, else null. Caller
 *     decides whether to fall back or fail.
 *   - "auto": walk the tier list and return the first available engine.
 *   - Empty tier list or nothing available: return null.
 */
export function resolveShotEngine(
  shot: Shot,
  ctx: MediaResolverContext,
): MediaEngine | null {
  if (shot.engineHint !== "auto") {
    return ctx.available.has(shot.engineHint) ? shot.engineHint : null;
  }
  for (const engine of ctx.tiers) {
    if (engine === "auto") continue;
    if (ctx.available.has(engine)) return engine;
  }
  return null;
}
