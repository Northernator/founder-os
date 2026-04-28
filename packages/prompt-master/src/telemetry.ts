/**
 * Telemetry facade for prompt-master events.
 *
 * Browser-safe: no node:* imports. Default sink is a no-op (records get
 * dropped silently). Node consumers call `installFsTelemetrySink()` from
 * "@founder-os/prompt-master/node" at startup to upgrade to disk-backed
 * append logging that the `prompt-master stats` CLI can compute against.
 *
 * If PROMPT_MASTER_VERBOSE=1 is set in the environment, the default sink
 * also tees events to console.log — useful for browser/devtools debugging
 * without needing a full backend.
 *
 * Telemetry must never break the actual optimization path. Sinks may throw;
 * the facade swallows everything.
 */

export type TelemetryEvent =
  | {
      event: "prompt_master.optimize";
      context: string;
      tokensSaved: number;
      cacheHit: boolean;
      latencyMs: number;
      transport: string;
    }
  | {
      event: "prompt_master.fallback";
      context: string;
      reason: string;
    };

export interface TelemetrySink {
  emit(event: TelemetryEvent): Promise<void>;
}

class NoopTelemetrySink implements TelemetrySink {
  async emit(event: TelemetryEvent): Promise<void> {
    // Tee to console in verbose mode — works in both Node and browser.
    const verbose =
      typeof globalThis.process !== "undefined" &&
      globalThis.process.env?.PROMPT_MASTER_VERBOSE === "1";
    if (verbose) {
      const line = JSON.stringify({ ...event, ts: new Date().toISOString() });
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }
}

let sink: TelemetrySink = new NoopTelemetrySink();

export function setTelemetrySink(impl: TelemetrySink): void {
  sink = impl;
}

export function getTelemetrySink(): TelemetrySink {
  return sink;
}

export async function emit(event: TelemetryEvent): Promise<void> {
  try {
    await sink.emit(event);
  } catch (err) {
    // Sink failures must never break optimize(). Log only.
    // eslint-disable-next-line no-console
    console.error("[prompt-master] telemetry sink failed:", err);
  }
}
