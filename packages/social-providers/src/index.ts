/**
 * @founder-os/social-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that spawns the
 * social-poster CLI, calls Postiz over HTTP, or writes drafts to disk
 * lives in the "./node" subpath:
 *
 *   import {
 *     createSocialPosterProvider,
 *     createPostizProvider,
 *     createConfigOnlyProvider,
 *     pickActiveSocialAdapter,
 *     getSocialDir,
 *   } from "@founder-os/social-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors @founder-os/media-providers, @founder-os/crm-providers,
 * @founder-os/handoff-providers, and @founder-os/backend-providers.
 *
 * Stub providers (BrightBean / TryPost) are pure type-importing factories
 * whose available() returns false and post() throws -- safe to ship in
 * the client barrel until their internals land.
 */

import type { SocialBackend } from "@founder-os/social-core";

// ---------------------------------------------------------------------------
// Capabilities -- the WebView reads this to render the backend selector
// without spawning anything.
// ---------------------------------------------------------------------------

export type SocialProviderCapability = {
  backend: SocialBackend;
  label: string;
  description: string;
  /**
   * True for backends that run on the user's machine without an external
   * service (social-poster, config_only). False for postiz / brightbean /
   * trypost which need an external endpoint or app registration.
   */
  isLocal: boolean;
  /**
   * True if the backend needs the user to register apps / paste API keys
   * before it can be used. The UI surfaces this so the no-setup tier_0
   * default (social-poster) is obviously different from the alternatives.
   */
  requiresSetup: boolean;
};

export const SOCIAL_PROVIDER_CAPABILITIES: ReadonlyArray<SocialProviderCapability> =
  [
    {
      backend: "social-poster",
      label: "social-poster",
      description:
        "Puppeteer-driven CLI by @profullstack. Drives your already-logged-in browser sessions -- no API keys, no OAuth app registration. One-time `sp login <platform>` per platform via terminal.",
      isLocal: true,
      requiresSetup: false,
    },
    {
      backend: "postiz",
      label: "Postiz",
      description:
        "Self-hosted scheduler + analytics via official platform APIs. Needs a running Postiz instance (Docker / Railway / Fly) plus an API key. More robust than social-poster but takes per-platform OAuth setup.",
      isLocal: false,
      requiresSetup: true,
    },
    {
      backend: "brightbean",
      label: "BrightBean Studio",
      description:
        "Reserved -- slice 2 ships a stub. Targets the broadest platform coverage of any open-source poster. Implementation deferred until a venture needs it.",
      isLocal: false,
      requiresSetup: true,
    },
    {
      backend: "trypost",
      label: "TryPost",
      description:
        "Reserved -- slice 2 ships a stub. MCP-server-shaped poster that would let Claude / Cursor schedule posts via natural language. Implementation deferred until the in-Founder-OS MCP gateway lands.",
      isLocal: false,
      requiresSetup: true,
    },
    {
      backend: "config_only",
      label: "Config only",
      description:
        "Write the post draft to 13_social/drafts/, do not actually post anywhere. Useful for review-before-send workflows or when no backend is configured.",
      isLocal: true,
      requiresSetup: false,
    },
  ];

// ---------------------------------------------------------------------------
// Probe envelope -- what the Tauri side returns when the WebView asks
// "is this backend currently usable?". Mirrors BackendProviderProbeResult.
// ---------------------------------------------------------------------------

export type SocialProviderProbeResult = {
  backend: SocialBackend;
  available: boolean;
  /**
   * Free-form note rendered in the UI when available=false:
   *  - social-poster: "sp CLI not found on PATH"
   *  - postiz:        "POSTIZ_BASE_URL or POSTIZ_API_KEY missing" /
   *                   "Postiz instance unreachable at <url>"
   *  - brightbean / trypost: "stub provider"
   *  - config_only:   never unavailable; always undefined.
   */
  reason?: string;
};

// ---------------------------------------------------------------------------
// Stub providers (safe to expose in the client barrel because they don't
// import node:*). The factory + error class + opts shape is the contract
// future implementations will swap internals against.
// ---------------------------------------------------------------------------

export {
  createBrightbeanProvider,
  BrightbeanNotImplementedError,
  type BrightbeanProviderOpts,
} from "./brightbean-provider.js";

export {
  createTrypostProvider,
  TrypostNotImplementedError,
  type TrypostProviderOpts,
} from "./trypost-provider.js";
