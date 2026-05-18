/**
 * @founder-os/handoff-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives the
 * Open CoDesign binary (subprocess + binary detection + clipboard injection
 * orchestration) lives in the "./node" subpath:
 *
 *   import {
 *     createCodesignLauncher,
 *     probeCodesignBinary,
 *   } from "@founder-os/handoff-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors the @founder-os/media-providers /
 * @founder-os/crm-providers / @founder-os/sales-agents splits.
 *
 * What lives here (client-safe):
 *   - Provider capability flags (so the WebView can render the right
 *     UI without spawning anything).
 *   - The pure prompt builder (HandoffExport + BrandBrief -> Markdown).
 *     This runs in the renderer and produces the clipboard payload
 *     before the Tauri spawn command is invoked.
 *   - Zod schemas / TS types for the probe + spawn envelopes that the
 *     renderer parses out of invoke() responses.
 *
 * The real `available()` probes and the actual subprocess.spawn() call
 * live in /node and are reached via Tauri commands (see
 * apps/founder-desktop/src-tauri/src/codesign.rs in slice 2).
 */

// Capability table + engine enum + envelope schemas.
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

// Pure prompt builder -- safe in the renderer.
export {
  buildCodesignPrompt,
  CODESIGN_PROMPT_HEADERS,
  type BuildCodesignPromptOpts,
  type PromptScreen,
} from "./prompt-builder.js";
