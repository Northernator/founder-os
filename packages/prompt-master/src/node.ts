/**
 * @founder-os/prompt-master/node — Node-only entry point.
 *
 * Anything that needs node:fs / node:path / node:os / node:crypto /
 * node:child_process lives here, NOT in the root barrel ("./"). Keeping
 * Node-only code on a separate subpath means the Tauri WebView and any
 * other browser-like consumer can import the root barrel without Vite
 * externalising Node modules and crashing module evaluation.
 *
 * Typical Node startup:
 *
 *   import { installNodeBackends, createClaudeCliTransport } from
 *     "@founder-os/prompt-master/node";
 *   import { setTransport } from "@founder-os/prompt-master";
 *
 *   installNodeBackends();          // disk cache + ndjson telemetry
 *   setTransport(createClaudeCliTransport());
 *
 * After that, anywhere in the Node app:
 *
 *   import { optimize } from "@founder-os/prompt-master";
 *   const { optimized } = await optimize({ prompt, context: "build" });
 */

import { installFsCacheBackend } from "./cache-fs.js";
import { installFsTelemetrySink } from "./telemetry-fs.js";

// Re-export individual installers so consumers can pick (e.g. only telemetry).
export { installFsCacheBackend } from "./cache-fs.js";
export { installFsTelemetrySink, getLogFile } from "./telemetry-fs.js";

// Node-only transports and helpers.
export {
  createClaudeCliTransport,
  type ClaudeCliTransportOpts,
} from "./transports/claude-cli.js";
export {
  readSharedConfig,
  writeSharedConfig,
  getSharedConfigPath,
  type PromptMasterConfig,
  type SharedConfig,
} from "./config.js";

// Backend interfaces (so consumers can build their own custom backends).
export type { CacheBackend, CachedEntry, CacheStats } from "./cache.js";
export type { TelemetrySink, TelemetryEvent } from "./telemetry.js";

/**
 * Convenience: install both the disk-backed cache and the ndjson telemetry
 * sink in one call. Most Node consumers want both.
 */
export function installNodeBackends(): void {
  installFsCacheBackend();
  installFsTelemetrySink();
}
