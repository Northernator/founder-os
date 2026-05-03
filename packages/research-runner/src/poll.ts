/**
 * pollJob -- helper that GETs /research/jobs/{id} on an interval until
 * the record reaches a terminal state (done / error) or a timeout
 * elapses or an AbortSignal aborts.
 *
 * Calls onProgress whenever progress_message changes, so UIs can render
 * a live status string without writing their own polling loop.
 *
 * Designed for both the desktop chat panel and the future runner CLI.
 */

import type { ResearchClient } from "./client.js";
import { ResearchClientError } from "./client.js";
import type { JobRecord } from "./types.js";

export interface PollJobOptions {
  /** Milliseconds between polls. Default 3000. */
  intervalMs?: number;
  /** Hard cap on total time to poll. Default 15 minutes. */
  timeoutMs?: number;
  /** Per-GET timeout passed through. Default 10_000. */
  requestTimeoutMs?: number;
  /** Cancel the loop early. Resolves with the last record seen. */
  signal?: AbortSignal;
  /** Fired on every poll where progress_message changed. */
  onProgress?: (record: JobRecord) => void;
  /** Fired on every poll, even when nothing changed. Useful for UI heartbeat. */
  onTick?: (record: JobRecord) => void;
}

export type PollJobOutcome =
  | { kind: "done"; record: JobRecord }
  | { kind: "error"; record: JobRecord }
  | { kind: "timeout"; record: JobRecord | null }
  | { kind: "aborted"; record: JobRecord | null };

export async function pollJob(
  client: ResearchClient,
  jobId: string,
  opts: PollJobOptions = {},
): Promise<PollJobOutcome> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const signal = opts.signal;

  let lastMessage = "";
  let lastRecord: JobRecord | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { kind: "aborted", record: lastRecord };
    }

    let record: JobRecord;
    try {
      record = await client.getJob(jobId);
    } catch (err) {
      // Network blips during polling are non-fatal -- the job itself is
      // still running server-side. Sleep and retry. Other errors (404
      // bad job id) propagate so the caller can show the message.
      if (err instanceof ResearchClientError && err.isNetwork) {
        await sleep(intervalMs, signal);
        continue;
      }
      throw err;
    }

    lastRecord = record;
    if (opts.onTick) opts.onTick(record);
    if (record.progress_message !== lastMessage) {
      lastMessage = record.progress_message;
      if (opts.onProgress) opts.onProgress(record);
    }

    if (record.status === "done") return { kind: "done", record };
    if (record.status === "error") return { kind: "error", record };

    await sleep(intervalMs, signal);
  }

  return { kind: "timeout", record: lastRecord };
}

/** Promise-based sleep that resolves early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
