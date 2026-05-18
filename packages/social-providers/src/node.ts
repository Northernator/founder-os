/**
 * @founder-os/social-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:fs/promises /
 * node:path lives here, NOT in the root barrel ("./"). The Tauri
 * WebView imports the root barrel only -- this subpath would crash
 * module evaluation in the renderer (Vite externalises node:* into
 * stubs that throw on access). Mirrors @founder-os/backend-providers,
 * @founder-os/media-providers, @founder-os/crm-providers, and
 * @founder-os/handoff-providers.
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createSocialPosterProvider,
 *     createPostizProvider,
 *     createConfigOnlyProvider,
 *     pickActiveSocialAdapter,
 *     getSocialDir,
 *     writeDraft,
 *     writeResult,
 *     readPostLog,
 *   } from "@founder-os/social-providers/node";
 *
 * The WebView side ("@founder-os/social-providers" root barrel) gives
 * you the capabilities list, the probe-result envelope, and the
 * BrightBean / TryPost stub providers -- everything needed to render
 * the backend selector and stub-out a SocialAdapter for type
 * convenience. The real adapters (social-poster, postiz, config_only)
 * live here; the WebView reaches them via Tauri commands (slice 3).
 */

// Subprocess primitives + error classes.
export {
  spawnSp,
  spawnSpJson,
  SocialPosterExitError,
  SocialPosterNotFoundError,
  SocialPosterTimeoutError,
  type SocialPosterSpawnOpts,
  type SocialPosterSpawnResult,
  type SpawnLike,
} from "./spawn.js";

// Per-venture path helpers + draft / result-log writers.
export {
  draftFilename,
  getSocialConfigPath,
  getSocialDir,
  getSocialDraftDir,
  getSocialPostsDir,
  getSocialScheduledDir,
  readPostLog,
  resultFilename,
  scheduledPayloadFilename,
  slugForFilename,
  writeDraft,
  writeResult,
  writeScheduledPayload,
} from "./paths.js";

// Real social-poster SocialAdapter factory + helpers exposed for tests
// and the desktop UI's "preview" mode (which builds the same args
// without spawning).
export {
  buildSpPostArgs,
  createSocialPosterProvider,
  groupPlatformsByOverride,
  trimToLongestCap,
  type BuildSpPostArgs,
  type CreateSocialPosterProviderOpts,
} from "./social-poster-provider.js";

// social-poster stdout parsers exposed for the drift-protection tests.
export {
  detectErrorCode,
  mapSpStatusToLoginState,
  parseSpPostStdout,
} from "./social-poster-parse.js";

// Real Postiz SocialAdapter factory + HTTP error classes.
export {
  createPostizProvider,
  type CreatePostizProviderOpts,
  PostizHealthError,
  PostizHttpError,
  PostizMediaUploadError,
  PostizRemoteHostBlockedError,
} from "./postiz-provider.js";

// Postiz HTTP primitives -- exposed for tests + for callers that want
// to talk to Postiz directly without going through the SocialAdapter
// surface (e.g. analytics fetchers).
export {
  assertLocalPostizHost,
  createPostizPost,
  listPostizIntegrations,
  postizHealthProbe,
  uploadPostizMedia,
  type FetchLike,
  type PostizCreatePostRequest,
  type PostizCreatePostResponse,
  type PostizCreatePostRow,
  type PostizHttpOpts,
  type PostizIntegration,
  type PostizUploadResult,
} from "./postiz-http.js";

// Always-available config_only provider.
export {
  createConfigOnlyProvider,
  type CreateConfigOnlyProviderOpts,
} from "./config-only-provider.js";

// Resolver -- picks first available adapter from the tier list.
export {
  pickActiveSocialAdapter,
  type SocialResolverAttempt,
  type SocialResolverInput,
  type SocialResolverResult,
} from "./resolver.js";
