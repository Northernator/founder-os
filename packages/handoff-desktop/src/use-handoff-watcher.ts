/**
 * Phase 2.3 — React hook that subscribes to the Rust-side handoff_watcher
 * events and dispatches them into the HandoffStore.
 *
 * Usage:
 *   useHandoffWatcher(activeVentureRoot);
 *
 * - Idempotent against active venture changes: stops the previous watcher
 *   before starting the new one.
 * - Tolerates Zod parse failures: bad payloads are logged + dropped, not
 *   thrown (the Rust side reads the file as a string; corrupt JSON or a
 *   schema drift shouldn't break the UI).
 * - Listens on:
 *     "handoff:result"   -> applyResult()
 *     "handoff:progress" -> applyProgress()
 *     "handoff:watcher-error" -> logged
 */

import {
  type HandoffProgressEvent,
  type HandoffResult,
  safeParseResult,
} from "@founder-os/handoff-contract";
import { createLogger } from "@founder-os/logger";
import { useHandoffStore } from "@founder-os/state";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

const log = createLogger("handoff-desktop:use-handoff-watcher");

interface HandoffEventPayload {
  runId: string;
  ventureRoot: string;
  body: string; // raw JSON text
}

export function useHandoffWatcher(ventureRoot: string | null | undefined): void {
  const applyResult = useHandoffStore((s) => s.applyResult);
  const applyProgress = useHandoffStore((s) => s.applyProgress);

  useEffect(() => {
    if (!ventureRoot) return;

    let cancelled = false;
    const unsubs: UnlistenFn[] = [];

    (async () => {
      try {
        await invoke("start_handoff_watcher", { ventureRoot });
      } catch (err) {
        log.warn("start_handoff_watcher failed: " + String(err));
        return;
      }
      if (cancelled) {
        await invoke("stop_handoff_watcher", { ventureRoot }).catch(() => {});
        return;
      }

      const onResult = await listen<HandoffEventPayload>("handoff:result", (evt) => {
        let parsed: { success: true; data: HandoffResult } | { success: false };
        try {
          const raw = JSON.parse(evt.payload.body);
          const r = safeParseResult(raw);
          parsed = r.success ? { success: true, data: r.data } : { success: false };
          if (!r.success) {
            log.warn("Bad HandoffResult from " + evt.payload.runId + ": " + r.error.message);
          }
        } catch (e) {
          log.warn("Bad JSON in handoff:result for " + evt.payload.runId + ": " + String(e));
          return;
        }
        if (parsed.success) applyResult(parsed.data);
      });
      unsubs.push(onResult);

      const onProgress = await listen<HandoffEventPayload>("handoff:progress", (evt) => {
        // HandoffProgressEvent doesn't have a safeParse helper exported
        // from handoff-contract today, but the shape is stable + simple.
        // We do a minimal structural check.
        try {
          const raw = JSON.parse(evt.payload.body) as HandoffProgressEvent;
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof raw.runId === "string" &&
            typeof raw.status === "string" &&
            typeof raw.emittedAt === "string"
          ) {
            applyProgress(raw);
          } else {
            log.warn("Bad HandoffProgressEvent shape for " + evt.payload.runId);
          }
        } catch (e) {
          log.warn("Bad JSON in handoff:progress for " + evt.payload.runId + ": " + String(e));
        }
      });
      unsubs.push(onProgress);

      const onError = await listen<string>("handoff:watcher-error", (evt) => {
        log.warn("watcher: " + evt.payload);
      });
      unsubs.push(onError);

      log.info("Handoff watcher attached for " + ventureRoot);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* no-op */
        }
      }
      // Best-effort stop on the Rust side.
      void invoke("stop_handoff_watcher", { ventureRoot }).catch(() => {});
    };
  }, [ventureRoot, applyResult, applyProgress]);
}
