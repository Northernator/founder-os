/**
 * @founder-os/handoff-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:path lives here,
 * NOT in the root barrel ("./"). The Tauri WebView imports the root barrel
 * only -- this subpath would crash module evaluation in the renderer (Vite
 * externalises node:* into stubs that throw on access). Mirrors the
 * @founder-os/media-providers / @founder-os/crm-providers splits.
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createCodesignLauncher,
 *     probeCodesignBinary,
 *     spawnCodesign,
 *     CodesignNotFoundError,
 *   } from "@founder-os/handoff-providers/node";
 *
 * The WebView side ("@founder-os/handoff-providers" root barrel) gives you
 * only the capability table and the pure prompt builder -- launching the
 * actual binary has to be done from Node (and from the desktop app that
 * means via a Tauri command in slice 2, see
 * apps/founder-desktop/src-tauri/src/codesign.rs).
 */

// Subprocess primitives + error classes.
export {
  spawnCodesign,
  CodesignSpawnError,
  CodesignNotFoundError,
  type CodesignSpawnOpts,
  type CodesignSpawnHandle,
} from "./spawn.js";

// Binary detection + launcher factory.
export {
  createCodesignLauncher,
  probeCodesignBinary,
  CODESIGN_BINARY_CANDIDATES,
  type CodesignLauncher,
  type CodesignLauncherOpts,
} from "./codesign-launcher.js";

// Re-export the client-safe surface so callers in Node can grab everything
// from "@founder-os/handoff-providers/node" without juggling two imports.
export {
  HANDOFF_LAUNCHER_CAPABILITIES,
  HandoffLauncherEngineSchema,
  HandoffProbeResultSchema,
  HandoffSpawnResultSchema,
  type HandoffLauncherCapability,
  type HandoffLauncherEngine,
  type HandoffProbeResult,
  type HandoffPromptResult,
  type HandoffSpawnResult,
} from "./types.js";

export {
  buildCodesignPrompt,
  CODESIGN_PROMPT_HEADERS,
  type BuildCodesignPromptOpts,
  type PromptScreen,
} from "./prompt-builder.js";
