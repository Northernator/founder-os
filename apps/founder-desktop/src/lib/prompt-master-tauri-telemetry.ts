import type { TelemetryEvent, TelemetrySink } from "@founder-os/prompt-master";
/**
 * Tauri-backed TelemetrySink for @founder-os/prompt-master.
 *
 * The default sink is a no-op — fine for ephemeral browser-only
 * deployments but it means the desktop app loses every emit the moment
 * the window closes. This sink persists every event to SQLite via the
 * `pm_event_log` Tauri command (see src-tauri/src/cache.rs and
 * migration 0008), which lets the Options-tab stats card show
 * lifetime-of-install numbers instead of session-only.
 *
 * Failure mode: telemetry MUST NOT break optimize(). The TelemetryEvent
 * facade in @founder-os/prompt-master swallows thrown errors at the
 * top level, but we belt-and-brace it here too so a Rust panic, a
 * permissions error, or a missing migration can't propagate.
 *
 * Why a thin wrapper instead of just using the Node ndjson sink:
 * biome.json explicitly forbids importing
 * "@founder-os/prompt-master/node" from this app — that entry point
 * pulls in node:fs and node:child_process, which Vite would externalise
 * and crash the WebView at module-init time.
 */
import { invoke } from "@tauri-apps/api/core";

/** The Rust column stores 'optimize' | 'fallback' (without the
 *  'prompt_master.' prefix) so the existing CLI ndjson schema can be
 *  ingested side-by-side later if we ever export the events. */
function shortenEvent(event: TelemetryEvent["event"]): string {
  return event === "prompt_master.optimize" ? "optimize" : "fallback";
}

function logTelemetryFault(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn("[prompt-master] tauri telemetry log failed (swallowed)", message);
}

export function createTauriTelemetrySink(): TelemetrySink {
  return {
    async emit(event: TelemetryEvent): Promise<void> {
      try {
        // ventureId is optional on both event variants. Coerce undefined
        // to null so the Tauri bridge serialises it as SQL NULL — passing
        // `undefined` would drop the kwarg and leave the bound parameter
        // unset (rusqlite treats that as a binding error).
        const ventureId = event.ventureId ?? null;
        if (event.event === "prompt_master.optimize") {
          // provider/model are added by migration 0010 — pre-migration
          // sinks would silently drop them. Coerce undefined → null so
          // rusqlite gets a real bind value (see ventureId comment).
          await invoke<void>("pm_event_log", {
            event: shortenEvent(event.event),
            context: event.context,
            tokensSaved: event.tokensSaved,
            cacheHit: event.cacheHit,
            transport: event.transport,
            latencyMs: event.latencyMs,
            ventureId,
            provider: event.provider ?? null,
            model: event.model ?? null,
          });
        } else {
          // Fallback events carry no transport / latency / tokens /
          // provider / model — pass null/zero so the SQL row is still
          // well-typed.
          await invoke<void>("pm_event_log", {
            event: shortenEvent(event.event),
            context: event.context,
            tokensSaved: 0,
            cacheHit: false,
            transport: null,
            latencyMs: null,
            ventureId,
            provider: null,
            model: null,
          });
        }
      } catch (err) {
        logTelemetryFault(err);
      }
    },
  };
}
