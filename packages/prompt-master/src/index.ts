/**
 * @founder-os/prompt-master public entry — CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that needs the Node
 * runtime (file-backed cache, ndjson telemetry, shared config on disk, the
 * Claude CLI transport) lives in the "./node" subpath:
 *
 *   import { installNodeBackends, createClaudeCliTransport } from
 *     "@founder-os/prompt-master/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer) bundles
 * this barrel via Vite. If Node-only code reached this file, Vite would
 * externalise the node:* imports and the resulting stubs throw on access,
 * crashing React mount before any UI renders. The split makes the boundary
 * a hard import-path error instead of a silent runtime crash.
 *
 * Typical desktop / browser startup:
 *
 *   import { setTransport } from "@founder-os/prompt-master";
 *   setTransport(myFetchBasedTransport);
 *
 * Then anywhere:
 *
 *   import { optimize } from "@founder-os/prompt-master";
 *   const { optimized, tokensSaved } = await optimize({
 *     prompt: systemPrompt,
 *     context: "handoff",
 *   });
 */

// Core dispatcher and transport registry — pure, browser-safe.
export { optimize } from "./core.js";
export { setTransport, getTransport, resetTransport, asTransport } from "./client.js";
export { NULL_TRANSPORT } from "./fallback.js";

// Backend hooks — consumers can plug custom in-memory or browser-storage
// backed backends without depending on the Node entry point.
export {
  setCacheBackend,
  getCacheBackend,
  inspectCache,
  type CacheBackend,
  type CachedEntry,
  type CacheStats,
} from "./cache.js";
export {
  setTelemetrySink,
  getTelemetrySink,
  type TelemetrySink,
  type TelemetryEvent,
} from "./telemetry.js";

// Stable cache-key helpers (Web Crypto-based; safe in any modern runtime).
export { hashKey, estimateTokens, PROMPT_MASTER_CACHE_VERSION } from "./hash.js";

// Public types.
export type {
  OptimizeInput,
  OptimizeResult,
  PromptContext,
  PromptMasterTransport,
} from "./types.js";

// Browser-safe transports (use fetch — no node:*).
export { createAnthropicSkillTransport } from "./transports/anthropic-skill.js";
export type { AnthropicSkillTransportOpts } from "./transports/anthropic-skill.js";
export { createAnthropicFetchTransport } from "./transports/anthropic-fetch.js";
export type { AnthropicFetchTransportOpts } from "./transports/anthropic-fetch.js";
