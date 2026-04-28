/**
 * Typed RPC layer over VS Code's webview postMessage API.
 *
 * Inside a VS Code webview, `acquireVsCodeApi()` is injected as a global once
 * per webview lifetime. We grab it here and expose a tiny `send` helper plus
 * a request/response wrapper that returns a Promise.
 */

import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from "@founder-os/mission-control-protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let _api: VsCodeApi | null = null;
function api(): VsCodeApi {
  if (_api) return _api;
  if (typeof window === "undefined" || !window.acquireVsCodeApi) {
    // Fallback so the dev server doesn't crash; messages get logged instead.
    console.warn("acquireVsCodeApi missing - running outside VS Code webview?");
    _api = {
      postMessage: (m) => console.log("[mock postMessage]", m),
      setState: () => {},
      getState: () => undefined,
    };
    return _api;
  }
  _api = window.acquireVsCodeApi();
  return _api;
}

/**
 * Distributive Omit — preserves discriminated union narrowing across the
 * Omit. The built-in `Omit<T, K>` collapses a union to its common keys
 * (just `"type"` for `WebviewToHostMessage`), which torpedoes call-site
 * type checking — the caller passes a variant-specific field like
 * `selection: string` and TS rejects it because the collapsed type
 * doesn't have that property.
 *
 * `T extends any ? Omit<T, K> : never` forces TS to distribute the Omit
 * across each member of the union, so each variant keeps its own fields.
 *
 * Pt.34d fix — was the source of ~20 TS2353 errors across the tabs.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Fire-and-forget. */
export function send(message: WebviewToHostMessage): void {
  api().postMessage(message);
}

/**
 * Send a message and await a typed response from the host. The host must
 * reply with `{ type: 'response', requestId, ok, ... }` keyed to the same
 * requestId we attach here.
 */
export function request<TResult = unknown>(
  message: DistributiveOmit<WebviewToHostMessage, "requestId">,
): Promise<TResult> {
  const requestId = "req-" + Math.random().toString(36).slice(2, 10);
  return new Promise<TResult>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      const m = ev.data as HostToWebviewMessage;
      if (m && m.type === "response" && m.requestId === requestId) {
        window.removeEventListener("message", handler);
        if (m.ok) resolve(m.result as TResult);
        else reject(new Error(m.error));
      }
    };
    window.addEventListener("message", handler);
    api().postMessage({ ...message, requestId });
    // Safety: time out after 30s so we don't leak handlers.
    setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Mission Control RPC timeout: " + message.type));
    }, 30_000);
  });
}

/** Subscribe to host->webview messages. Returns an unsubscribe fn. */
export function onHostMessage(
  cb: (m: HostToWebviewMessage) => void,
): () => void {
  const handler = (ev: MessageEvent) => {
    const m = ev.data as HostToWebviewMessage;
    if (m && typeof m === "object" && "type" in m) cb(m);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
