/**
 * @founder-os/media-edit-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:path lives
 * here, NOT in the root barrel ("./"). The Tauri WebView imports the
 * root barrel only -- this subpath would crash module evaluation in
 * the renderer (Vite externalises node:* into stubs that throw on
 * access). Mirrors the @founder-os/media-providers and
 * @founder-os/handoff-providers splits.
 *
 * Typical Node startup (CLI / Tauri sidecar / stage-runner orchestration):
 *
 *   import {
 *     createOpencutProvider,
 *     probeBunRuntime,
 *     validateOpencutVendor,
 *     BunNotFoundError,
 *   } from "@founder-os/media-edit-providers/node";
 *
 * The WebView side ("@founder-os/media-edit-providers" root barrel)
 * gives you only the config_only provider plus pure types. OpenCut has
 * to be driven from Node -- when invoked from the desktop app that
 * happens via a Tauri command that shells out to this surface.
 */

// Spawn primitives + error classes.
export {
  runBun,
  spawnBunDev,
  openInBrowser,
  BunNotFoundError,
  BunTimeoutError,
  BunExitError,
  type RunBunOpts,
  type RunBunResult,
  type SpawnBunDevOpts,
  type SpawnBunDevResult,
  type OpenInBrowserOpts,
} from "./spawn.js";

// Probe helpers.
export {
  probeBunRuntime,
  validateOpencutVendor,
  type BunRuntimeProbe,
  type OpencutVendorProbe,
} from "./probe.js";

// OpenCut MediaEditProvider factory.
export {
  createOpencutProvider,
  type CreateOpencutProviderOpts,
} from "./opencut-provider.js";

// config_only re-exported here for callers that want a single import
// surface from /node.
export {
  createConfigOnlyProvider,
  type CreateConfigOnlyProviderOpts,
} from "./config-only-provider.js";
