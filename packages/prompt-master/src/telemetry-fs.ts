/**
 * File-backed telemetry sink for prompt-master events.
 *
 * NODE-ONLY. Imports node:fs/promises etc directly. Reach this module via:
 *   import { installFsTelemetrySink, getLogFile } from "@founder-os/prompt-master/node";
 *
 * Two consumers:
 *   - The dev console (stdout JSON one-line-per-event, when
 *     PROMPT_MASTER_VERBOSE=1) so you can `tail` it during local pipeline
 *     runs and watch tokens-saved tick up.
 *   - A disk-backed log at $PROMPT_MASTER_LOG_DIR/events.ndjson (default
 *     ~/.founder-os/cache/prompt-master/events.ndjson) so the
 *     `prompt-master stats` CLI can compute cumulative savings without
 *     wiring a real telemetry backend in v1.
 *
 * Disk writes are append-only and best-effort — a write failure logs to
 * stderr and is otherwise swallowed. Telemetry must never break the actual
 * optimization path.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type TelemetryEvent, type TelemetrySink, setTelemetrySink } from "./telemetry.js";

function logDir(): string {
  return (
    process.env.PROMPT_MASTER_LOG_DIR ?? join(homedir(), ".founder-os", "cache", "prompt-master")
  );
}

function logFileInternal(): string {
  return join(logDir(), "events.ndjson");
}

export function getLogFile(): string {
  return logFileInternal();
}

class FsTelemetrySink implements TelemetrySink {
  private directoryEnsured = false;

  private async ensureDir(): Promise<void> {
    if (this.directoryEnsured) return;
    await mkdir(dirname(logFileInternal()), { recursive: true });
    this.directoryEnsured = true;
  }

  async emit(event: TelemetryEvent): Promise<void> {
    const line = JSON.stringify({ ...event, ts: new Date().toISOString() });

    if (process.env.PROMPT_MASTER_VERBOSE === "1") {
      // eslint-disable-next-line no-console
      console.log(line);
    }

    try {
      await this.ensureDir();
      await appendFile(logFileInternal(), line + "\n", "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[prompt-master] telemetry write failed:", err);
    }
  }
}

/**
 * Install the disk-backed telemetry sink. Call once at Node startup.
 * Idempotent — calling twice replaces the sink with a fresh instance.
 */
export function installFsTelemetrySink(): void {
  setTelemetrySink(new FsTelemetrySink());
}
