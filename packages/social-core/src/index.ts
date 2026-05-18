// @founder-os/social-core -- contract for the social-posting standalone
// utility (NOT a pipeline stage).
//
// Slice 1: types + zod schemas + parse helpers + defaults only.
// No adapter implementations, no subprocess code, no HTTP -- those live
// in @founder-os/social-providers (slice 2). See
// bizBuild/SOCIAL-MODULE-SPEC.md for the design.
//
// Standalone, not a stage: posting is a fire-and-forget action driven
// from <SocialActions> mounted in MediaTab + LaunchTab; there is no
// SocialStageRunner, no review gates, and workspace-core does NOT own
// the per-venture folder helpers (that lives in
// @founder-os/social-providers/node/paths.ts in slice 2 to keep
// workspace-core reserved for stage artifacts).
//
// Tier_0 backend is `social-poster` (Puppeteer CLI, no API keys);
// tier_1 is `postiz` (REST API against a self-hosted Postiz instance).
// The other three slots (brightbean / trypost / config_only) are
// reserved for future opt-in -- slice 2 stubs them with available()=false
// so the resolver never picks them but the contract surface is locked.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Platforms + backends
// ---------------------------------------------------------------------------

/**
 * Platforms the package can post to. The set is the intersection of what
 * `social-poster` and `postiz` both support today (slice 2). Adding a
 * new platform requires (a) extending this enum, (b) extending
 * SOCIAL_PLATFORM_CAPTION_CAPS, (c) extending
 * SOCIAL_PLATFORM_SUPPORTED_MEDIA_KINDS, (d) verifying the adapter can
 * actually drive it.
 */
export const SocialPlatformSchema = z.enum([
  "x",          // Twitter / X
  "instagram",
  "linkedin",
  "facebook",
  "tiktok",
  "youtube",    // Shorts only for v1 -- long-form needs a different flow
  "threads",
  "bluesky",
  "mastodon",
  "reddit",
  "pinterest",
]);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

/**
 * Backend implementations the package knows how to dispatch to. Tier_0 is
 * `social-poster` (no API keys, Puppeteer-driven); tier_1 is `postiz`
 * (official APIs via a self-hosted Postiz instance); tiers 2-4 are stubs
 * in slice 2 with available()=false so the resolver never picks them.
 */
export const SocialBackendSchema = z.enum([
  "social-poster", // tier_0 -- Puppeteer, no API keys, default
  "postiz",        // tier_1 -- official APIs via self-hosted Postiz REST
  "brightbean",    // tier_2 -- reserved (BrightBean Studio)
  "trypost",       // tier_3 -- reserved (TryPost MCP server)
  "config_only",   // tier_4 -- emit drafts, do not post
]);
export type SocialBackend = z.infer<typeof SocialBackendSchema>;

/**
 * Default backend resolution order for new ventures. Per spec sec 3,
 * `social-poster` is the explicit default; `postiz` is a manual fallback
 * once a venture chooses to stand up a Postiz instance. brightbean /
 * trypost / config_only are intentionally absent from the default tier
 * list -- opt-in per venture via venture.yaml under
 * `social.enabledBackends`.
 */
export const SOCIAL_BACKEND_TIERS_DEFAULT: ReadonlyArray<SocialBackend> = [
  "social-poster",
  "postiz",
];

// ---------------------------------------------------------------------------
// Per-platform metadata -- caption caps + supported media kinds
// ---------------------------------------------------------------------------

/**
 * Maximum caption length per platform, in characters. The adapter trims
 * with a `...` suffix when the post payload exceeds the cap; the
 * original full text is preserved in the draft + result log so nothing
 * is lost.
 *
 * Sources (verified 2026-05-15): platform docs / known limits. These
 * are the safe upper bounds; some platforms allow longer in special
 * cases (X premium, LinkedIn articles vs posts). Slice 2's adapter
 * uses these as the trim anchor regardless of account tier.
 */
export const SOCIAL_PLATFORM_CAPTION_CAPS: Record<SocialPlatform, number> = {
  x: 280,
  instagram: 2200,
  linkedin: 3000,
  facebook: 63206,
  tiktok: 2200,
  youtube: 5000,    // Shorts description cap
  threads: 500,
  bluesky: 300,
  mastodon: 500,    // default; instances may raise it
  reddit: 40000,    // self-post body cap
  pinterest: 500,
};

/**
 * Supported media kinds per platform. `null` slots in `SocialMediaKind`
 * mean text-only is allowed; missing kinds mean the adapter rejects the
 * post payload at validate-time (rather than silently dropping the
 * media).
 *
 * Notes:
 *   - reddit: image+video supported but link-posts are the more common
 *     case; the adapter treats text-only as the default.
 *   - youtube: Shorts only -- long-form upload via `sp` works but takes
 *     a different code path that v1 doesn't ship.
 */
export const SOCIAL_PLATFORM_SUPPORTED_MEDIA_KINDS: Record<
  SocialPlatform,
  ReadonlyArray<SocialMediaKind>
> = {
  x: ["image", "video", "gif"],
  instagram: ["image", "video"],          // gif uploaded as mp4 by IG
  linkedin: ["image", "video"],
  facebook: ["image", "video", "gif"],
  tiktok: ["video"],
  youtube: ["video"],                     // Shorts only -- vertical, <=60s
  threads: ["image", "video"],
  bluesky: ["image", "video"],
  mastodon: ["image", "video", "gif"],
  reddit: ["image", "video"],
  pinterest: ["image", "video"],
};

/**
 * Default platforms a venture posts to when `social.enabledPlatforms`
 * is empty. Curated to the lowest-friction set for the user's stated
 * project mix (vibe-coded SaaS / extensions / games):
 *   - x: highest discovery for tech launches
 *   - linkedin: professional reach for SaaS announcements
 *   - bluesky: growing tech audience, no API quirks (app-password auth)
 *
 * Instagram / TikTok / YouTube are NOT in the default because they need
 * platform-specific media flows the user should opt into per venture.
 */
export const SOCIAL_DEFAULT_PLATFORMS: ReadonlyArray<SocialPlatform> = [
  "x",
  "linkedin",
  "bluesky",
];

// ---------------------------------------------------------------------------
// Media references
// ---------------------------------------------------------------------------

export const SocialMediaKindSchema = z.enum(["image", "video", "gif"]);
export type SocialMediaKind = z.infer<typeof SocialMediaKindSchema>;

/**
 * Reference to a media file on disk. The path is absolute (the adapter
 * checks existence + computes the digest on first read). Digests are
 * persisted in the draft + result log so the same file can be re-posted
 * without re-uploading via Postiz's media endpoint, and so the post
 * history is reproducible from the venture root.
 */
export const SocialMediaRefSchema = z.object({
  path: z.string().min(1),
  kind: SocialMediaKindSchema,
  digestSha256: z.string().optional(),
});
export type SocialMediaRef = z.infer<typeof SocialMediaRefSchema>;

// ---------------------------------------------------------------------------
// SocialPost -- input to adapter.post()
// ---------------------------------------------------------------------------

/**
 * Per-platform overrides applied on top of the base SocialPost.text. The
 * adapter resolves the effective caption per platform as:
 *   overrides[platform].text ?? base.text  (then trimmed to the cap)
 *
 * Hashtags are appended to the resolved caption as ` #tag1 #tag2`,
 * trimmed if the combined length exceeds the platform cap.
 */
export const SocialPerPlatformOverrideSchema = z.object({
  text: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
});
export type SocialPerPlatformOverride = z.infer<
  typeof SocialPerPlatformOverrideSchema
>;

/**
 * The post payload the adapter accepts. `text` is the base caption
 * (capped at the longest platform's limit -- LinkedIn at 3000); per-
 * platform overrides may shorten it further. `platforms` is required
 * and explicit -- there is no implicit "all" to avoid surprise posts
 * to platforms the user forgot to log out of.
 */
export const SocialPostSchema = z.object({
  ventureSlug: z.string().min(1),
  text: z.string().max(3000),
  media: z.array(SocialMediaRefSchema).max(10).optional(),
  platforms: z.array(SocialPlatformSchema).min(1),
  perPlatformOverrides: z
    .record(SocialPlatformSchema, SocialPerPlatformOverrideSchema)
    .optional(),
  /**
   * ISO 8601 datetime. Null/undefined means "post immediately". Only
   * `postiz` honours this in slice 2; `social-poster` rejects scheduled
   * posts at validate-time (slice 2's resolver returns a typed error
   * row). Future tier_5 ("os-scheduled-task") would let the OS scheduler
   * re-invoke the adapter at the target time.
   */
  scheduleAt: z.string().datetime().optional(),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

// ---------------------------------------------------------------------------
// SocialResult -- output from adapter.post()
// ---------------------------------------------------------------------------

export const SocialResultRowSchema = z.object({
  platform: SocialPlatformSchema,
  success: z.boolean(),
  /**
   * Permalink on the platform. Set on success; undefined for scheduled
   * posts (where the platform URL is only known after the schedule
   * fires) and on failure.
   */
  postUrl: z.string().url().optional(),
  /**
   * Platform-native ID (tweet ID, Instagram media ID, etc). Useful for
   * later analytics fetches and for delete operations.
   */
  postId: z.string().optional(),
  /**
   * Free-text error message on failure. Not parsed by the package, but
   * the desktop UI surfaces it verbatim in the result row.
   */
  error: z.string().optional(),
  /**
   * Structured error code for known failure modes. Slice 2's parser
   * detects rate-limit / not-logged-in / media-rejected errors from
   * the adapter stdout and surfaces them here so the UI can render a
   * smart action (re-login, retry-after, transcode hint).
   */
  errorCode: z
    .enum([
      "not-logged-in",
      "rate-limited",
      "media-rejected",
      "scheduled-not-supported",
      "platform-down",
      "unknown",
    ])
    .optional(),
  timestamp: z.string().datetime(),
});
export type SocialResultRow = z.infer<typeof SocialResultRowSchema>;

/**
 * The artifact written under `13_social/posts/<timestamp>-<slug>.result.json`
 * after every post attempt. Provider-agnostic: a `social-poster` run and
 * a `postiz` run produce identical JSON shape, only `backend` and
 * `rawAdapterPayload` differ. Mirrors HandoffExport / BackendExport.
 */
export const SocialResultSchema = z.object({
  ventureSlug: z.string().min(1),
  backend: SocialBackendSchema,
  postedAt: z.string().datetime(),
  rows: z.array(SocialResultRowSchema),
  /**
   * Adapter's verbatim response (sp stdout JSON, Postiz REST envelope,
   * etc). Schema-typed `unknown` so consumers must explicitly opt into
   * adapter-specific parsing -- avoids accidental coupling.
   */
  rawAdapterPayload: z.unknown().optional(),
});
export type SocialResult = z.infer<typeof SocialResultSchema>;

// ---------------------------------------------------------------------------
// Per-venture config (lives under VentureManifest.social)
// ---------------------------------------------------------------------------

/**
 * social-poster-specific knobs. The CLI is invoked via PATH probing by
 * default; `cliPath` lets a venture pin to an absolute path if they have
 * multiple Node toolchains installed.
 *
 * `captionLLM` selects which Founder OS LLM provider generates per-
 * platform caption variants. Null disables AI caption generation
 * entirely; the user types each platform's caption by hand via
 * `perPlatformOverrides`.
 */
export const SocialPosterConfigSchema = z.object({
  cliPath: z.string().default("sp"),
  captionLLM: z
    .enum(["openai", "anthropic", "gemini"])
    .nullable()
    .default("openai"),
});
export type SocialPosterConfig = z.infer<typeof SocialPosterConfigSchema>;

/**
 * Postiz-specific knobs. `baseUrl` is required when the venture's
 * backend is `postiz`; the API key is read from the env var named in
 * `apiKeyEnvVar` and is NEVER persisted to venture.yaml.
 *
 * `allowRemoteOnly` is the local-first guard analogue of
 * crm-providers' assertLocalHost: when true, the adapter refuses to
 * call non-localhost / non-LAN Postiz instances. Default is `false`
 * because most Postiz deployments are on remote VPSes; flip it on for
 * compliance-sensitive ventures.
 */
export const PostizConfigSchema = z.object({
  baseUrl: z.string().default(""),
  apiKeyEnvVar: z.string().default("POSTIZ_API_KEY"),
  allowRemoteOnly: z.boolean().default(false),
});
export type PostizConfig = z.infer<typeof PostizConfigSchema>;

export const SocialConfigSchema = z.object({
  /**
   * Set false to hide the social UI entirely for this venture. Useful
   * for internal tools and pure-backend services where there's no story
   * to post about.
   */
  enabled: z.boolean().default(true),
  /**
   * Required string -- per spec sec 3 there is no `auto` resolver mode
   * for social. The user picks a backend, the package uses it. Default
   * is `social-poster` to match the spec's tier_0 stance.
   */
  backend: SocialBackendSchema.default("social-poster"),
  /**
   * Resolver fallback list. If `backend`'s available() returns false,
   * the resolver walks this list in order. social-poster -> postiz is
   * the default per SOCIAL_BACKEND_TIERS_DEFAULT.
   */
  enabledBackends: z
    .array(SocialBackendSchema)
    .default([...SOCIAL_BACKEND_TIERS_DEFAULT]),
  /**
   * Default platforms <SocialActions> pre-fills when the user opens the
   * compose modal. Overridden per-post via SocialPost.platforms.
   */
  enabledPlatforms: z
    .array(SocialPlatformSchema)
    .default([...SOCIAL_DEFAULT_PLATFORMS]),
  "social-poster": SocialPosterConfigSchema.optional(),
  postiz: PostizConfigSchema.optional(),
});
export type SocialConfig = z.infer<typeof SocialConfigSchema>;

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export type SocialLoginStateValue = "logged_in" | "logged_out" | "unknown";

/**
 * Per-platform login state. Partial because adapters may not know about
 * every platform in the enum (e.g. social-poster supports a subset of
 * the SocialPlatform set). Missing platforms are treated as "unknown"
 * by the UI.
 */
export type SocialLoginState = Partial<
  Record<SocialPlatform, SocialLoginStateValue>
>;

/**
 * Probe envelope returned by adapter.available(). The reason is
 * surfaced in the desktop pill tooltip so the user knows whether to
 * `npm install -g` something, paste a key, or fix a network issue.
 */
export type SocialAvailability = {
  available: boolean;
  reason?: string;
};

/**
 * Implemented by every backend (social-poster + postiz + 3 stubs).
 * Slice 2 ships the social-poster + postiz implementations; slice 1
 * only declares the contract. The stub backends expose this shape with
 * available()=false + post() that throws a typed NotImplementedError,
 * so the resolver never picks them but consumers can detect them.
 */
export interface SocialAdapter {
  readonly name: SocialBackend;
  available(): Promise<SocialAvailability>;
  loginState(): Promise<SocialLoginState>;
  post(payload: SocialPost): Promise<SocialResult>;
}

// ---------------------------------------------------------------------------
// Parse helper re-exports -- the actual helpers live in parse.ts so callers
// can import the focused module if they want, but the barrel surface is the
// canonical entry point.
// ---------------------------------------------------------------------------

export {
  parseSocialConfig,
  safeParseSocialConfig,
  parseSocialPost,
  safeParseSocialPost,
  parseSocialResult,
  safeParseSocialResult,
  parseSocialMediaRef,
  safeParseSocialMediaRef,
  parsePostizConfig,
  safeParsePostizConfig,
  parseSocialPosterConfig,
  safeParseSocialPosterConfig,
} from "./parse.js";
