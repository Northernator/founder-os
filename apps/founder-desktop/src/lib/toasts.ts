/**
 * Toast notification store.
 *
 * App-wide primitive for surfacing transient events — keychain failures,
 * auto-migrations, anything the user ought to know about but that doesn't
 * fit on a specific component. Backed by zustand; intentionally tiny.
 *
 * Usage:
 *   import { pushToast } from "../lib/toasts.js";
 *   pushToast({ kind: "error", message: "Couldn't save key to keychain" });
 *
 * Rendering:
 *   ToastContainer in features/toasts subscribes to the store and renders
 *   the stack. Mount it once at the app root (see App.tsx).
 *
 * Behaviour:
 *   - Auto-dismiss timers are kind-specific (below). Errors are sticky so
 *     the user has to click X — failures shouldn't vanish while the user
 *     is in another window.
 *   - Dedupe-by-message: pushing an identical message while a toast is
 *     still on screen refreshes its TTL instead of stacking. Keeps the
 *     corner uncluttered when something goes wrong across N providers at
 *     once.
 */
import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "error";

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  /** Optional second line — rendered smaller, monospace for error details. */
  detail?: string;
  /** ms until auto-dismiss. 0 = sticky. */
  ttlMs: number;
  /** ms epoch when this toast was first created — used for dedupe refresh. */
  createdAt: number;
};

type ToastState = {
  toasts: Toast[];
  push: (input: PushInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export type PushInput = {
  kind: ToastKind;
  message: string;
  detail?: string;
  /** Override the default TTL for this kind. Set to 0 for sticky. */
  ttlMs?: number;
};

const DEFAULT_TTL: Record<ToastKind, number> = {
  // 3s reads easily and doesn't linger past the next interaction.
  info: 3000,
  success: 3000,
  // Slightly longer because warns usually want reading before they vanish.
  warn: 5000,
  // 0 = sticky. Errors require acknowledgement.
  error: 0,
};

// Timer handles per-toast id. Kept outside the store so React state updates
// stay cheap and serialisable (timers aren't). Cleared on dismiss and on
// refresh (dedupe-by-message).
const timers = new Map<string, number>();

function scheduleAutoDismiss(id: string, ttlMs: number, dismiss: (id: string) => void) {
  if (ttlMs <= 0) return; // sticky
  const existing = timers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  const handle = window.setTimeout(() => {
    timers.delete(id);
    dismiss(id);
  }, ttlMs);
  timers.set(id, handle);
}

function cancelTimer(id: string) {
  const handle = timers.get(id);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    timers.delete(id);
  }
}

// crypto.randomUUID is available in Tauri's WebView; fall back to a timestamp
// string on the wildly unlikely chance it's missing.
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (input) => {
    const ttlMs = input.ttlMs ?? DEFAULT_TTL[input.kind];

    // Dedupe: if a toast with an identical (kind, message, detail) is still
    // on screen, refresh its TTL rather than stacking a duplicate. Same
    // message = same id = same React element, so no flicker.
    const existing = get().toasts.find(
      (t) =>
        t.kind === input.kind &&
        t.message === input.message &&
        t.detail === input.detail
    );
    if (existing) {
      scheduleAutoDismiss(existing.id, ttlMs, get().dismiss);
      return existing.id;
    }

    const toast: Toast = {
      id: newId(),
      kind: input.kind,
      message: input.message,
      detail: input.detail,
      ttlMs,
      createdAt: Date.now(),
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    scheduleAutoDismiss(toast.id, ttlMs, get().dismiss);
    return toast.id;
  },

  dismiss: (id) => {
    cancelTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  clear: () => {
    // Cancel every outstanding timer so we don't dismiss something that
    // was re-pushed after `clear()`.
    for (const id of timers.keys()) {
      cancelTimer(id);
    }
    set({ toasts: [] });
  },
}));

/**
 * Imperative helper — call from anywhere (including non-React code like
 * db.ts helpers) without having to thread the store through.
 */
export function pushToast(input: PushInput): string {
  return useToastStore.getState().push(input);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}
