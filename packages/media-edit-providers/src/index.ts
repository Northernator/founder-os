/**
 * @founder-os/media-edit-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives the
 * OpenCut Next.js app (bun spawn + dev-server lifecycle + provider
 * factory) lives in the "./node" subpath:
 *
 *   import {
 *     createOpencutProvider,
 *     probeBunRuntime,
 *   } from "@founder-os/media-edit-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file
 * Vite would externalise the node:* imports and the resulting stubs
 * throw on access, crashing React mount before any UI renders. The
 * split makes the boundary a hard import-path error instead of a
 * silent runtime crash. Mirrors @founder-os/media-providers,
 * @founder-os/handoff-providers, and @founder-os/crm-providers.
 *
 * Slice 2 ships:
 *   - config_only provider (pure, no Node deps; safe in the barrel)
 *   - Re-exported types/capabilities from @founder-os/media-edit-core
 *     so a consumer can import everything from one place
 */

// Re-export the contract package surface so consumers have a single
// import source. None of these names trigger any Node imports.
export type {
  EditProjectExport,
  EditProjectBrandHints,
  EditProjectSourceShot,
  EditedReelReceipt,
  MediaEditCapability,
  MediaEditConfig,
  MediaEditEngine,
  MediaEditProbeResult,
  MediaEditProvider,
  MediaEditServerStatus,
  MediaEditSpawnResult,
} from "@founder-os/media-edit-core";

export {
  CLIP_MANIFEST_FILENAME,
  DEFAULT_AWAIT_EXPORT_TIMEOUT_MS,
  DEFAULT_MEDIA_EDIT_ENGINE,
  DEFAULT_OPENCUT_DEV_PORT,
  EDITED_REEL_FILENAME,
  EDIT_RECEIPT_FILENAME,
  MEDIA_EDIT_CAPABILITIES,
  OPENCUT_EXPORT_SENTINEL_FILENAME,
  OPENCUT_VENDOR_DIRNAME,
  buildClipManifestMarkdown,
  getMediaEditCapability,
  resolveMediaEditEngine,
} from "@founder-os/media-edit-core";

// config_only provider -- pure, ships in the client barrel.
export {
  createConfigOnlyProvider,
  type CreateConfigOnlyProviderOpts,
} from "./config-only-provider.js";
