/**
 * @founder-os/media-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:path lives here,
 * NOT in the root barrel ("./"). The Tauri WebView imports the root barrel
 * only -- this subpath would crash module evaluation in the renderer (Vite
 * externalises node:* into stubs that throw on access). Mirrors the
 * @founder-os/prompt-master and @founder-os/sales-agents splits.
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createHyperframesProvider,
 *     bootstrapHyperframesProject,
 *     addCatalogItems,
 *     HyperframesNotFoundError,
 *     runHyperframesJson,
 *   } from "@founder-os/media-providers/node";
 *
 * The WebView side ("@founder-os/media-providers" root barrel) gives you
 * only the stub providers (Wan2/CogVideoX/Veo) plus pure types. HyperFrames
 * has to be driven from Node -- when invoked from the desktop app, that
 * happens via a Tauri command that shells out to this surface (or invokes
 * the CLI directly via cli_agent::resolve_binary).
 */

// Subprocess primitives + error classes.
export {
  runHyperframes,
  runHyperframesJson,
  HyperframesExitError,
  HyperframesNotFoundError,
  HyperframesTimeoutError,
  type SpawnOpts,
  type SpawnResult,
} from "./spawn.js";

// Project lifecycle helpers (bootstrap, add catalog items, variables file).
export {
  bootstrapHyperframesProject,
  addCatalogItems,
  assertHyperframesProject,
  projectPaths,
  writeVariablesFile,
  type BootstrapOpts,
  type ProjectPaths,
} from "./ensure-project.js";

// HyperFrames MediaProvider factory + gate-specific errors.
export {
  createHyperframesProvider,
  HyperframesLintError,
  HyperframesLayoutError,
  type CreateHyperframesProviderOpts,
} from "./hyperframes-provider.js";
