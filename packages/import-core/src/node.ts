/**
 * @founder-os/import-core/node -- Node-only entry point.
 *
 * Anything that touches node:crypto / node:fs / node:path lives here, NOT
 * in the root barrel ("./"). The Tauri WebView imports the root barrel
 * only -- this subpath would crash module evaluation in the renderer
 * (Vite externalises node:* into stubs that throw on access).
 *
 * Pattern mirrors @founder-os/media-providers/node,
 * @founder-os/handoff-providers/node, @founder-os/handoff-pack-providers/node.
 */

export { hashFile } from "./node/hash-file.js";
export {
  type StageOriginalOpts,
  type StageOriginalResult,
  stageOriginal,
} from "./node/stage-original.js";
export {
  type MagicProbeResult,
  probeMagicBytes,
} from "./node/magic-bytes.js";
