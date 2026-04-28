/**
 * CLI-agent bridge — the TS side of subscription-mode providers.
 *
 * When a provider row has `mode: 'subscription'`, `streamChat` routes
 * through here instead of `llm-client.ts`. Under the hood we call the
 * Rust `cli_agent_*` commands which spawn the vendor's own CLI
 * (`claude`, `codex`, `gemini`) — see `src-tauri/src/cli_agent.rs` for
 * the full rationale.
 *
 * Stream events (`llm-delta`, `llm-done`, `llm-cancel`, `llm-error`) use
 * the exact same channels and payload shapes as `llm_stream`, so we
 * deliberately keep the subscribe/filter/cleanup logic symmetric with
 * `llm-client.ts`. Two transports, one public surface.
 *
 * Login is its own flow — the vendor CLI prints a URL, opens the user's
 * default browser, and polls for the OAuth callback itself. We surface
 * the CLI's stdout/stderr lines over `cli-login-output` so the UI can
 * show "waiting for browser..." and the auth URL in case the browser
 * didn't launch automatically.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Only these providers have a subscription CLI today. See
 *  `cli_agent.rs::agent_config` for the canonical source. */
export type CliAgentId = "anthropic" | "openai" | "gemini";

export const CLI_AGENT_IDS: readonly CliAgentId[] = [
  "anthropic",
  "openai",
  "gemini",
];

/** Human-visible CLI metadata — what we show on each subscription card. */
export const CLI_AGENT_META: Record<
  CliAgentId,
  {
    displayName: string;
    binary: string;
    installUrl: string;
    subscriptionName: string;
  }
> = {
  anthropic: {
    displayName: "Claude (Anthropic)",
    binary: "claude",
    installUrl: "https://docs.anthropic.com/claude-code",
    subscriptionName: "Claude Pro / Max",
  },
  openai: {
    displayName: "ChatGPT (OpenAI Codex)",
    binary: "codex",
    installUrl: "https://github.com/openai/codex",
    subscriptionName: "ChatGPT Plus / Pro",
  },
  gemini: {
    displayName: "Gemini (Google)",
    binary: "gemini",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    subscriptionName: "Gemini Advanced / Google AI Pro",
  },
};

// ──────────────────────────────────────────────
// Install / sign-in check
// ──────────────────────────────────────────────

export type CliStatus = {
  installed: boolean;
  version: string | null;
  /** Heuristic: the vendor's credentials file exists and is non-empty.
   *  Not a guarantee the token is valid — a prompt send that fails will
   *  surface the CLI's own error message. */
  signedInHint: boolean;
};

export async function cliCheckInstalled(agent: CliAgentId): Promise<CliStatus> {
  return invoke<CliStatus>("cli_agent_check", { agent });
}

// ──────────────────────────────────────────────
// Login
// ──────────────────────────────────────────────

export type CliLoginOptions = {
  /** Line-at-a-time output from the CLI while the login subprocess is
   *  live. Use this to stream the auth URL / status into the UI. */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  /** Abort the in-flight login (SIGTERM / taskkill the child). */
  signal?: AbortSignal;
};

type LoginOutputPayload = {
  requestId: string;
  line: string;
  stream: "stdout" | "stderr";
};
type LoginDonePayload = {
  requestId: string;
  success: boolean;
  message: string;
};

/**
 * Drive the vendor CLI's sign-in flow. Resolves with `true` on clean
 * exit (the CLI printed "success" and wrote credentials), `false` on
 * non-zero exit. Rejects only on transport errors (the Rust spawn
 * failed or the listener blew up).
 *
 * We don't wrap failures into an exception because the common non-zero
 * paths (user closed the browser, URL expired, etc.) aren't errors in
 * the programming sense — they're user choices. The UI shows "didn't
 * finish" and offers to retry.
 */
export async function cliLogin(
  agent: CliAgentId,
  opts: CliLoginOptions = {}
): Promise<boolean> {
  const requestId = makeRequestId();
  const unlisteners: UnlistenFn[] = [];
  let settled = false;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    for (const un of unlisteners) {
      try {
        un();
      } catch {
        /* listener already dropped — fine */
      }
    }
  };

  return new Promise<boolean>(async (resolve, reject) => {
    try {
      unlisteners.push(
        await listen<LoginOutputPayload>("cli-login-output", (event) => {
          if (event.payload.requestId !== requestId) return;
          opts.onOutput?.(event.payload.line, event.payload.stream);
        })
      );
      unlisteners.push(
        await listen<LoginDonePayload>("cli-login-done", (event) => {
          if (event.payload.requestId !== requestId) return;
          cleanup();
          if (event.payload.success) {
            resolve(true);
          } else if (event.payload.message) {
            // A transport-level error (couldn't spawn at all) gets
            // reported via `message`. Treat those as rejections — the
            // caller UI handles them differently from "user quit the
            // browser" non-zero exits.
            reject(new Error(event.payload.message));
          } else {
            resolve(false);
          }
        })
      );

      // Cancel: on abort we can't cleanly stop the browser, but we can
      // stop polling for the callback. The Rust side will kill the
      // child; we just need to make sure the promise settles.
      if (opts.signal) {
        const onAbort = () => {
          cleanup();
          // No RPC to kill the login child today — the vendor CLI's
          // own timeout will wind it down, and the user has already
          // moved on. Resolve to `false` rather than reject so the UI
          // just shows "cancelled" instead of a scary error state.
          resolve(false);
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      await invoke("cli_agent_login", { agent, requestId });
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ──────────────────────────────────────────────
// Streaming prompt
// ──────────────────────────────────────────────

export type CliStreamOptions = {
  /** Invoked as the CLI's stdout arrives. Granularity is per-line,
   *  not per-token — see `cli_agent.rs` for the rationale. */
  onDelta?: (delta: string) => void;
  onDone?: (text: string) => void;
  onCancel?: (partial: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
};

type DeltaPayload = { requestId: string; delta: string };
type DonePayload = { requestId: string; text: string };
type CancelPayload = { requestId: string; text: string };
type ErrorPayload = { requestId: string; message: string };

class AbortError extends Error {
  name = "AbortError";
  readonly partial: string;
  constructor(partial: string, message = "stream cancelled") {
    super(message);
    this.partial = partial;
  }
}

/**
 * Stream a single prompt through the vendor CLI. Signature mirrors
 * `streamChat` so the dispatcher in `llm-client.ts` can swap in
 * whichever transport without the callsite caring.
 *
 * Cancellation reuses the exact same `llm_cancel` command as HTTP
 * streams — the Rust `CancelRegistry` is transport-agnostic.
 */
export async function cliStream(
  agent: CliAgentId,
  prompt: string,
  opts: CliStreamOptions = {}
): Promise<string> {
  if (opts.signal?.aborted) {
    throw new AbortError("", "stream cancelled before start");
  }

  const requestId = makeRequestId();
  const unlisteners: UnlistenFn[] = [];
  let settled = false;
  let accumulated = "";
  let onAbort: (() => void) | null = null;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (onAbort && opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
    for (const un of unlisteners) {
      try {
        un();
      } catch {
        /* already dropped */
      }
    }
  };

  return new Promise<string>(async (resolve, reject) => {
    try {
      unlisteners.push(
        await listen<DeltaPayload>("llm-delta", (event) => {
          if (event.payload.requestId !== requestId) return;
          accumulated += event.payload.delta;
          opts.onDelta?.(event.payload.delta);
        })
      );
      unlisteners.push(
        await listen<DonePayload>("llm-done", (event) => {
          if (event.payload.requestId !== requestId) return;
          opts.onDone?.(event.payload.text);
          cleanup();
          resolve(event.payload.text);
        })
      );
      unlisteners.push(
        await listen<CancelPayload>("llm-cancel", (event) => {
          if (event.payload.requestId !== requestId) return;
          const partial = event.payload.text || accumulated;
          opts.onCancel?.(partial);
          cleanup();
          reject(new AbortError(partial));
        })
      );
      unlisteners.push(
        await listen<ErrorPayload>("llm-error", (event) => {
          if (event.payload.requestId !== requestId) return;
          const msg = event.payload.message || "unknown cli error";
          opts.onError?.(msg);
          cleanup();
          reject(new Error(msg));
        })
      );

      if (opts.signal) {
        onAbort = () => {
          // Same `llm_cancel` command as the HTTP path — the registry
          // doesn't care which transport owns the request id.
          void invoke("llm_cancel", { requestId }).catch((err) => {
            console.warn("[cli] llm_cancel invoke failed", err);
            opts.onCancel?.(accumulated);
            cleanup();
            reject(new AbortError(accumulated));
          });
        };
        opts.signal.addEventListener("abort", onAbort);
      }

      await invoke("cli_agent_stream", {
        req: { requestId, agent, prompt },
      });

      // Covers the race where `abort()` fires between the pre-flight
      // check and `addEventListener` — same guard as `llm-client.ts`.
      if (opts.signal?.aborted && !settled) {
        void invoke("llm_cancel", { requestId }).catch(() => {});
      }
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function makeRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
