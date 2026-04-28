/**
 * Prompt Master initialisation for the desktop app.
 *
 * Three pieces of wiring run here, in this order:
 *
 *   1. Cache backend → SQLite via three Tauri commands. Persists optimised
 *      prompts across window restarts so the second session can score a
 *      cache hit on the same system prompt instead of re-running the
 *      optimizer. See prompt-master-tauri-cache.ts and
 *      src-tauri/src/cache.rs.
 *
 *   2. Telemetry sink → SQLite via `pm_event_log`. Persists every
 *      optimize/fallback event so the Options-tab stats card can show
 *      lifetime tokens-saved + cache hit rate without shelling out to
 *      the CLI. See prompt-master-tauri-telemetry.ts and migration 0008.
 *
 *   3. Transport → reuses the user's active LLM provider auth via
 *      streamChat / pickActiveProvider. No separate API key needed; if
 *      the user has nothing configured, the transport short-circuits to
 *      identity and optimize() returns the input with fallbackUsed=true.
 *
 * Backend + telemetry MUST be set before the transport. Wiring the
 * transport first would mean the very first optimize() call between
 * init and backend registration would write to the in-memory default
 * and orphan that entry — minor, but no reason to leave the gap. The
 * telemetry sink ordering matters for the same reason: a fallback emit
 * during the gap would land in the no-op default and never surface in
 * the lifetime stats.
 */
import { setCacheBackend, setTelemetrySink, setTransport } from "@founder-os/prompt-master";
import { createStreamChatTransport } from "./prompt-master-stream-transport.js";
import { createTauriCacheBackend } from "./prompt-master-tauri-cache.js";
import { createTauriTelemetrySink } from "./prompt-master-tauri-telemetry.js";

export function initPromptMaster(): void {
  setCacheBackend(createTauriCacheBackend());
  setTelemetrySink(createTauriTelemetrySink());
  setTransport(createStreamChatTransport());
  console.info(
    "[prompt-master] tauri cache + telemetry + stream-chat transport registered (persistent cache, persistent telemetry, active LLM provider auth)"
  );
}
