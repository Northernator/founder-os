/**
 * "A failed file does not fail the job."
 *
 * Every per-file step is wrapped in this helper -- it catches, logs, and
 * returns a tagged result so the orchestrator can mark the source doc
 * extractionStatus: failed without short-circuiting the rest of the batch.
 */

import type { ImportLogger } from "./ports";

export type SafelyRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export interface SafelyRunOpts {
  logger: ImportLogger;
  /** Used for the log event name -- e.g. "stage-original" or "compute-hash". */
  step: string;
  /** Per-file identifier so we can tell which file failed in the logs. */
  itemKey: string;
}

export async function safelyRunPerFile<T>(
  fn: () => Promise<T>,
  opts: SafelyRunOpts,
): Promise<SafelyRunResult<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    opts.logger.warn("import-core.per-file.failed", {
      step: opts.step,
      itemKey: opts.itemKey,
      error: error.message,
    });
    return { ok: false, error };
  }
}
