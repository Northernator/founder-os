// Re-export the public constants from index.ts as a focused entry point
// for callers that only need defaults (e.g. the desktop app's
// <SocialActions> rendering "Default platforms: x, linkedin, bluesky"
// before any post has been composed).
//
// Splitting these out matches the @founder-os/backend-core /
// @founder-os/media-core / @founder-os/crm-core convention where preset
// constants are reachable without pulling in the full schema surface.

export {
  SOCIAL_BACKEND_TIERS_DEFAULT,
  SOCIAL_PLATFORM_CAPTION_CAPS,
  SOCIAL_PLATFORM_SUPPORTED_MEDIA_KINDS,
  SOCIAL_DEFAULT_PLATFORMS,
} from "./index.js";
