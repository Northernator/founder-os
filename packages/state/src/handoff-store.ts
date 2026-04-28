import type { HandoffProgressEvent, HandoffResult } from "@founder-os/handoff-contract";
import { create } from "zustand";

export type HandoffEntry = {
  runId: string;
  ventureId: string;
  type: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  percentComplete: number;
  lastMessage?: string;
  startedAt: string;
  completedAt?: string;
  /** Phase 2.3 — populated when a HandoffResult comes back from the extension. */
  producedArtifacts?: Array<{ artifactId: string; path: string; type: string }>;
  /** Phase 2.3 — error message captured from a failed result. */
  error?: string;
  /** Phase 2.3 — short summary line from the runner (success only). */
  summary?: string;
};

export type HandoffStore = {
  handoffs: HandoffEntry[];

  upsertHandoff: (entry: HandoffEntry) => void;
  applyProgress: (evt: HandoffProgressEvent) => void;
  /** Phase 2.3 — apply a HandoffResult ingested via the Tauri watcher. */
  applyResult: (result: HandoffResult) => void;
  getHandoff: (runId: string) => HandoffEntry | undefined;
  /** Wipe the store (used when switching ventures). */
  clear: () => void;
};

export const useHandoffStore = create<HandoffStore>()((set, get) => ({
  handoffs: [],

  upsertHandoff: (entry) =>
    set((state) => {
      const existing = state.handoffs.find((h) => h.runId === entry.runId);
      if (existing) {
        return {
          handoffs: state.handoffs.map((h) => (h.runId === entry.runId ? { ...h, ...entry } : h)),
        };
      }
      return { handoffs: [...state.handoffs, entry] };
    }),

  applyProgress: (evt) =>
    set((state) => {
      // If we don't have an entry for this runId yet, synthesise one - the
      // Phase 2.3 watcher can deliver progress events for runs that haven't
      // been previously upserted (e.g. extension crashed before sending the
      // initial entry).
      const existing = state.handoffs.find((h) => h.runId === evt.runId);
      if (!existing) {
        return {
          handoffs: [
            ...state.handoffs,
            {
              runId: evt.runId,
              ventureId: "(unknown)",
              type: "(unknown)",
              status: evt.status as HandoffEntry["status"],
              percentComplete: evt.percentComplete ?? 0,
              lastMessage: evt.message,
              startedAt: evt.emittedAt,
              ...(evt.status === "success" || evt.status === "failed"
                ? { completedAt: evt.emittedAt }
                : {}),
            },
          ],
        };
      }
      return {
        handoffs: state.handoffs.map((h) =>
          h.runId === evt.runId
            ? {
                ...h,
                status: evt.status as HandoffEntry["status"],
                percentComplete: evt.percentComplete ?? h.percentComplete,
                lastMessage: evt.message ?? h.lastMessage,
                ...(evt.status === "success" || evt.status === "failed"
                  ? { completedAt: evt.emittedAt }
                  : {}),
              }
            : h
        ),
      };
    }),

  applyResult: (result) =>
    set((state) => {
      const existing = state.handoffs.find((h) => h.runId === result.runId);
      const baseFields: Partial<HandoffEntry> = {
        runId: result.runId,
        ventureId: result.ventureId,
        status: result.status as HandoffEntry["status"],
        percentComplete: 100,
        completedAt: result.completedAt,
        producedArtifacts: result.producedArtifacts,
        error: result.error,
        summary: result.summary,
      };
      if (existing) {
        return {
          handoffs: state.handoffs.map((h) =>
            h.runId === result.runId ? { ...h, ...baseFields } : h
          ),
        };
      }
      // Synthesise an entry if this is the first we've seen of this run.
      return {
        handoffs: [
          ...state.handoffs,
          {
            runId: result.runId,
            ventureId: result.ventureId,
            type: "(unknown)",
            status: result.status as HandoffEntry["status"],
            percentComplete: 100,
            startedAt: result.completedAt,
            completedAt: result.completedAt,
            producedArtifacts: result.producedArtifacts,
            error: result.error,
            summary: result.summary,
          },
        ],
      };
    }),

  getHandoff: (runId) => get().handoffs.find((h) => h.runId === runId),

  clear: () => set({ handoffs: [] }),
}));
