/**
 * @founder-os/research-deep-providers/node — Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:path lives here,
 * NOT in the root barrel ("./"). The Tauri WebView imports the root barrel
 * only — this subpath would crash module evaluation in the renderer (Vite
 * externalises node:* into stubs that throw on access). Mirrors the
 * @founder-os/media-providers/node split.
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createGeminiSubProvider,
 *     isGeminiCliAvailable,
 *     GeminiNotFoundError,
 *   } from "@founder-os/research-deep-providers/node";
 *
 *   // claude-sub / chatgpt-sub / paste-in are imported from the root
 *   // barrel — they are client-safe and don't need this subpath.
 */

// Re-export everything from the client barrel so a Node-side consumer
// can do a single import-from-node and get the full provider surface.
export * from "./index.js";

// Node-only: subprocess primitives + error classes for the gemini-cli driver.
export {
  runGemini,
  isGeminiCliAvailable,
  GeminiNotFoundError,
  GeminiTimeoutError,
  GeminiExitError,
  type GeminiSpawnOpts,
  type GeminiSpawnResult,
} from "./spawn.js";

// Node-only: gemini-sub provider factory (spawns gemini-cli).
export {
  createGeminiSubProvider,
  GeminiSubInvocationError,
  type CreateGeminiSubProviderOpts,
} from "./gemini-sub-provider.js";
