/**
 * useAbortableTask (pt.30a) — small hook that bundles the
 * (ref + optimistic-stopping flag + cancel function) triple used by
 * every long-running task in the desktop app.
 *
 * Three call sites had grown the same shape independently:
 *  - chat (handleSend / handleCancelChat)
 *  - pipeline (handleRunPipeline / handleCancelPipeline)
 *  - reports (handleGenerateResearchReports / handleCancelReports)
 *
 * The chat path stays inlined for now — it has extra partial-text
 * preservation logic that doesn't fit the simple shape. The pipeline
 * and reports paths use this hook so the abort plumbing lives in one
 * place.
 *
 * Usage:
 *   const task = useAbortableTask();
 *
 *   async function startWork() {
 *     const controller = task.begin();         // fresh per run
 *     try {
 *       await doStuff({ signal: controller.signal });
 *     } catch (err) {
 *       const cancelled = task.wasCancelled(controller, err);
 *       // ...
 *     } finally {
 *       task.clear();                          // ALWAYS clear in finally
 *     }
 *   }
 *
 *   <Button onClick={task.cancel} disabled={task.stopping}>
 *     {task.stopping ? "Stopping…" : "Stop"}
 *   </Button>
 *
 *   {/* visibility check — `ref.current` is set between begin/clear *\/}
 *   {isRunning && task.ref.current && <Button .../>}
 *
 * Why a ref (not state) for the controller:
 *  - We don't render based on the controller identity itself; visibility
 *    is keyed on a separate `isRunning` state owned by the caller.
 *  - Refs avoid an extra re-render on `begin()` and on `clear()`.
 *  - The optimistic `stopping` flag IS state, because the Stop button's
 *    disabled/label depends on it and we want immediate feedback.
 */
import { useCallback, useRef, useState } from "react";

export type UseAbortableTaskResult = {
  /** Live controller for the currently in-flight task, or null when idle. */
  ref: React.MutableRefObject<AbortController | null>;
  /**
   * Optimistic flag — true the moment Stop is clicked, false again when
   * the task settles (`clear()` called in finally). Drives the Stop
   * button's label / disabled state so the user sees "Stopping…"
   * immediately, before the underlying Rust cancel round-trips.
   */
  stopping: boolean;
  /**
   * Start a new task. Creates a fresh AbortController, parks it in
   * `ref.current`, returns it so the caller can pass `controller.signal`
   * downstream. Idempotent in the sense that calling `begin()` while
   * another task is in flight will replace the old controller — but
   * the caller should guard against that at the entry point (e.g.
   * `if (isRunning) return`).
   */
  begin: () => AbortController;
  /**
   * User-initiated cancel. Flips `stopping` true and aborts the
   * controller. No-op when nothing is running or the user already hit
   * Stop. Belt-and-braces against keyboard double-fires; the Stop
   * button is also disabled in those states.
   */
  cancel: () => void;
  /**
   * Clear the controller and stopping flag. Always call from the
   * caller's finally block — even on early returns (e.g. no provider
   * configured) — so the Stop button vanishes and a future run gets a
   * clean slate.
   */
  clear: () => void;
  /**
   * Discriminator for cancel-vs-failure in catch blocks. Returns true
   * when (a) the controller's signal was aborted OR (b) the thrown
   * error has `name === "AbortError"`. The signal check is the more
   * reliable path because some callers (orchestrator's internal catch)
   * swallow the AbortError name and re-throw a plain Error.
   *
   * Pass the SAME controller you passed to your in-flight work — not
   * `ref.current`, which has been cleared by the time finally runs.
   */
  wasCancelled: (controller: AbortController, err: unknown) => boolean;
};

export function useAbortableTask(): UseAbortableTaskResult {
  const ref = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);

  const begin = useCallback((): AbortController => {
    const controller = new AbortController();
    ref.current = controller;
    return controller;
  }, []);

  const cancel = useCallback(() => {
    if (!ref.current || stopping) return;
    setStopping(true);
    ref.current.abort();
  }, [stopping]);

  const clear = useCallback(() => {
    ref.current = null;
    setStopping(false);
  }, []);

  const wasCancelled = useCallback((controller: AbortController, err: unknown): boolean => {
    if (controller.signal.aborted) return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    return false;
  }, []);

  return { ref, stopping, begin, cancel, clear, wasCancelled };
}
