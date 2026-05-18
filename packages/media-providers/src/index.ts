/**
 * @founder-os/media-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives the
 * HyperFrames CLI (subprocess + project lifecycle + provider factory)
 * lives in the "./node" subpath:
 *
 *   import {
 *     createHyperframesProvider,
 *     bootstrapHyperframesProject,
 *   } from "@founder-os/media-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors the @founder-os/prompt-master and @founder-os/sales-agents
 * splits.
 *
 * Slice 6 stub providers (Wan2 / CogVideoX / Veo) are pure type-importing
 * factories whose available() returns false and render() throws; they're
 * safe to ship in the client barrel until their internals land.
 */

// Stub providers (slice 6). Pure -- only import types from media-core.
export {
  createWan2Provider,
  Wan2NotImplementedError,
  type Wan2ProviderOpts,
} from "./wan2-provider.js";

export {
  createCogVideoXProvider,
  CogVideoXNotImplementedError,
  type CogVideoXProviderOpts,
} from "./cogvideox-provider.js";

export {
  createVeoProvider,
  VeoNotImplementedError,
  type VeoProviderOpts,
} from "./veo-provider.js";
