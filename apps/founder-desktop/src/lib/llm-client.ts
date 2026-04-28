import { type LlmMessage, type LlmProviderId, getProvider } from "@founder-os/llm-providers";
/**
 * Thin wrapper around the Rust `llm_stream` command.
 *
 * The Rust side fires four global Tauri event channels (`llm-delta`,
 * `llm-done`, `llm-cancel`, `llm-error`), each carrying a `requestId` so
 * concurrent sends don't stomp each other. This module subscribes once per
 * call, filters by id, and exposes a `Promise<string>` that resolves with
 * the final text while delivering partial tokens via `onDelta`.
 *
 * Keys never leave this process: the UI reads the API key from SQLite, passes
 * it straight into `invoke`, and the Rust side uses it to authenticate the
 * outbound HTTP call. That's deliberate — storing keys in a Tauri state cell
 * would add lock contention for no security benefit on a single-user desktop.
 *
 * Cancellation: callers pass an `AbortSignal` and call `controller.abort()` to
 * stop a runaway response. We invoke `llm_cancel` on the Rust side, which
 * flips the per-request flag; the stream reader observes it on the next SSE
 * event and closes the TLS connection. The Rust side then emits `llm-cancel`
 * with whatever text it accumulated, we fire `onCancel`, and the promise
 * rejects with an `AbortError` (matches the Web Streams / fetch cancel
 * convention so callers can use `err.name === "AbortError"` checks).
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { CLI_AGENT_IDS, type CliAgentId, cliStream } from "./cli-client.js";
import * as db from "./db.js";

/** Providers for which a subscription CLI bridge exists. Keeping this as
 *  a Set (not the imported array) lets `isCliSubscriptionProvider` be an
 *  O(1) type-narrowing check in the dispatcher below. */
const CLI_PROVIDER_SET: ReadonlySet<string> = new Set(CLI_AGENT_IDS);

function isCliSubscriptionProvider(id: string): id is CliAgentId {
  return CLI_PROVIDER_SET.has(id);
}

/**
 * Serialize the chat turn list into a single string prompt for a CLI
 * transport. The vendor CLIs are one-shot — each send replays the whole
 * conversation — so we label each turn explicitly. System prompts go at
 * the top as a plain prefix; the CLIs have their own notion of "system"
 * but passing a leading instruction block works uniformly.
 *
 * Keep this layout stable: the CLI sees no conversational metadata
 * besides what's in the string, so changing the labels mid-session
 * would reset the model's implicit "who's speaking" prior.
 */
function messagesToCliPrompt(messages: LlmMessage[], system: string | undefined): string {
  const parts: string[] = [];
  if (system && system.trim().length > 0) {
    parts.push(`System instructions:\n${system.trim()}`);
  }
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
    parts.push(`${role}:\n${m.content}`);
  }
  // Trailing "Assistant:" is a common convention that nudges the model
  // to continue in assistant voice. The CLI will still produce a full
  // turn — this just primes the format.
  parts.push("Assistant:");
  return parts.join("\n\n");
}

export type StreamChatOptions = {
  provider: LlmProviderId;
  messages: LlmMessage[];
  /** Optional system prompt prepended to the conversation. */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Invoked once per incoming token. Safe to no-op for non-streaming callers. */
  onDelta?: (delta: string) => void;
  /** Invoked at most once, with the full final text. Equivalent to the
   *  promise's resolved value — provided for callers that prefer a callback. */
  onDone?: (text: string) => void;
  /**
   * Invoked if the user cancelled the stream via `signal.abort()`. `partial`
   * is whatever text the provider emitted before the cancel took effect.
   * The promise itself rejects with an `AbortError`; `onCancel` is for
   * callers that want the partial text without parsing the rejection.
   */
  onCancel?: (partial: string) => void;
  /** Invoked if the call fails (network, auth, provider error). The promise
   *  also rejects with the same error. */
  onError?: (message: string) => void;
  /**
   * Abort signal. Call `controller.abort()` to cancel the in-flight stream.
   * If the signal is already aborted when `streamChat` is called, the
   * promise rejects synchronously (no provider request is made).
   */
  signal?: AbortSignal;
  /**
   * Enable server-side web search. Honored only by providers that support
   * it (`catalog.supportsWebSearch === true`); silently ignored otherwise
   * so callers don't have to branch on provider id.
   *
   * Today: Anthropic only (`web_search_20250305`). The model decides
   * whether to invoke the tool — we just make it available. Each search
   * adds real billed tokens, so prefer to flip this on for research-style
   * turns and leave it off for everyday chat.
   */
  enableWebSearch?: boolean;
  /** Upper bound on web searches per request. Defaults to 5 when unset. */
  webSearchMaxUses?: number;
};

function makeRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type DeltaPayload = { requestId: string; delta: string };
type DonePayload = { requestId: string; text: string };
type CancelPayload = { requestId: string; text: string };
type ErrorPayload = { requestId: string; message: string };

/**
 * DOM-compatible abort error. Matches `new DOMException("…", "AbortError")`
 * as produced by `fetch` + `AbortController` so downstream callers can use
 * the standard `err.name === "AbortError"` check.
 *
 * We don't use `DOMException` directly because Tauri's WebView supports it
 * but the build target (TypeScript lib target) sometimes doesn't include it
 * in the ambient types. A plain `Error` with the right `name` is equivalent
 * for runtime-check purposes.
 */
class AbortError extends Error {
  name = "AbortError";
  /** The partial text the provider emitted before the cancel took effect. */
  readonly partial: string;
  constructor(partial: string, message = "stream cancelled") {
    super(message);
    this.partial = partial;
  }
}

/**
 * Start a streaming chat call. Resolves with the full text once the provider
 * closes the stream. Rejects on error or user cancel. `onDelta` is called for
 * every partial chunk while the stream is open.
 *
 * Settings (api key, base URL override, model) are loaded from `llm_settings`
 * by provider id. Caller doesn't need to pass them — the Options tab is the
 * single source of truth.
 *
 * Cancel: pass `signal` from an `AbortController`. When aborted, we fire
 * `llm_cancel` on the Rust side, emit `onCancel(partial)` once the cancel
 * event returns, and reject with an `AbortError` carrying the same partial.
 */
export async function streamChat(opts: StreamChatOptions): Promise<string> {
  // Pre-flight: if the caller passed an already-aborted signal, there's no
  // reason to even read settings or generate a request id. Rejecting
  // synchronously keeps the abort semantics tight — the stream never starts.
  if (opts.signal?.aborted) {
    throw new AbortError("", "stream cancelled before start");
  }

  const catalog = getProvider(opts.provider);
  const setting = await db.getLlmSetting(opts.provider);

  // Prompt Master optimisation is the call site's responsibility now.
  // Two reasons it lives outside this function:
  //   1. The optimizer transport calls streamChat itself; running optimize
  //      here would recurse forever (streamChat -> optimize -> transport ->
  //      streamChat -> optimize -> ...). Doing it at the caller breaks the
  //      cycle because the transport's inner streamChat skips the wrap.
  //   2. Each surface (chat, audit-fix, pipeline-step, brand-gen, …) wants
  //      its own PromptContext label for telemetry. A site-local optimize()
  //      call is the natural place to set that.
  // Callers should:
  //   const { optimized, tokensSaved } = await optimize({
  //     prompt: systemPrompt, context: "venture-chat",
  //   });
  //   await streamChat({ system: optimized, ... });

  // Transport dispatch: subscription mode shells out to the vendor CLI
  // (`claude`, `codex`, `gemini`) via `cli-client.ts`. The event channel
  // names and cancel semantics match the HTTP path one-for-one, so the
  // only thing the dispatcher does differently is flatten the chat
  // messages into a single CLI prompt string.
  //
  // We check BOTH the per-provider `mode` and `isCliSubscriptionProvider`
  // because a malformed row could say `mode: 'subscription'` for a
  // provider that doesn't have a CLI (e.g. DeepSeek) — fall back to the
  // HTTP path rather than erroring in that case; the API key check below
  // will still surface a clear "no key saved" message if relevant.
  if (setting?.mode === "subscription" && isCliSubscriptionProvider(opts.provider)) {
    const prompt = messagesToCliPrompt(opts.messages, opts.system);
    return cliStream(opts.provider, prompt, {
      onDelta: opts.onDelta,
      onDone: opts.onDone,
      onCancel: opts.onCancel,
      onError: opts.onError,
      signal: opts.signal,
    });
  }

  if (catalog.requiresApiKey && !setting?.apiKey) {
    throw new Error(
      `No API key saved for ${catalog.displayName}. Open the Options tab to paste one.`
    );
  }

  const model = setting?.model || catalog.defaultModel;
  const baseUrl = setting?.baseUrl || catalog.defaultBaseUrl;
  const requestId = makeRequestId();

  // Subscribe BEFORE we invoke: the Rust side spawns and can start emitting
  // `llm-delta` before `invoke` resolves, so attaching listeners afterwards
  // races and can miss the opening tokens.
  const unlisteners: UnlistenFn[] = [];
  let settled = false;
  // Track the accumulated text on the TS side as a fallback. The Rust side
  // sends the full text in `llm-cancel`, but if the cancel races with the
  // AbortSignal handler we want to resolve the promise immediately anyway
  // and still be able to hand the caller whatever we saw.
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
        /* listener already dropped — fine */
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
          const msg = event.payload.message || "unknown llm error";
          opts.onError?.(msg);
          cleanup();
          reject(new Error(msg));
        })
      );

      // Wire up the abort signal. On abort we fire the Rust cancel command;
      // the Rust side will emit `llm-cancel` once its SSE reader observes
      // the flag, and the listener above takes over from there. If the
      // invoke of `llm_cancel` fails (unlikely — it's just a map lookup)
      // we fall back to rejecting directly so the UI doesn't hang.
      if (opts.signal) {
        onAbort = () => {
          void invoke("llm_cancel", { requestId }).catch((err) => {
            console.warn("[llm] llm_cancel invoke failed", err);
            opts.onCancel?.(accumulated);
            cleanup();
            reject(new AbortError(accumulated));
          });
        };
        opts.signal.addEventListener("abort", onAbort);
      }

      // Only forward web-search flags when (a) the caller asked, AND (b)
      // the provider supports it. Saves a round-trip-irrelevant field on
      // every non-Anthropic call and keeps the Rust side simple.
      const webSearchEnabled = opts.enableWebSearch === true && catalog.supportsWebSearch === true;

      await invoke("llm_stream", {
        req: {
          requestId,
          kind: catalog.kind,
          provider: opts.provider,
          apiKey: setting?.apiKey ?? null,
          baseUrl,
          model,
          messages: opts.messages,
          system: opts.system,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          enableWebSearch: webSearchEnabled ? true : undefined,
          webSearchMaxUses: webSearchEnabled ? opts.webSearchMaxUses : undefined,
        },
      });

      // Guard the race where `abort()` fires after our pre-flight check but
      // before `addEventListener("abort", onAbort)` — the abort event has
      // already dispatched, so a newly attached handler never hears it. Now
      // that the Rust registry definitely has the flag (llm_stream just
      // returned), kick the cancel through directly. If the signal wasn't
      // aborted this is a no-op.
      if (opts.signal?.aborted && !settled) {
        void invoke("llm_cancel", { requestId }).catch(() => {});
      }
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Pick the provider to use for a given send. Returns null if none is usable.
 *
 * Preference order (first match wins):
 *   1. Per-venture override in `ventures.default_provider` (if `ventureId`
 *      provided and the referenced provider is enabled + keyed).
 *   2. Global `app_settings.active_provider`, if enabled + keyed.
 *   3. First enabled provider with a saved key (catalog order).
 *
 * Pass `ventureId` when sending from a venture-scoped context (chat on a
 * specific venture, fix-suggestion on an audit finding). Omit it for
 * venture-agnostic calls (e.g. admin-level operations).
 *
 * The chat caller should surface a helpful error when this returns null,
 * pointing the user at the Options tab.
 */
export async function pickActiveProvider(ventureId?: string): Promise<LlmProviderId | null> {
  // Pull the venture override in parallel with global settings; the override
  // is just a string column and costs basically nothing vs. the double round
  // trip of fetching it only when needed.
  const [venturePref, active, settings] = await Promise.all([
    ventureId ? db.getVentureProvider(ventureId) : Promise.resolve(null),
    db.getAppSetting(db.ACTIVE_PROVIDER_KEY),
    db.listLlmSettings(),
  ]);
  const usable = (s: db.LlmSetting): boolean => {
    if (!s.enabled) return false;
    // Subscription mode delegates auth to the vendor CLI; there's no
    // API key to validate here. `cli_agent_stream` will surface a
    // clear error at send time if the CLI isn't installed or signed
    // in, which is the right place for that diagnostic (we don't
    // want to probe every CLI on every provider pick just to filter
    // the list).
    if (s.mode === "subscription") {
      return isCliSubscriptionProvider(s.provider);
    }
    const catalog = getProvider(s.provider as LlmProviderId);
    if (catalog.requiresApiKey && (!s.apiKey || s.apiKey.trim().length === 0)) {
      return false;
    }
    return true;
  };

  // 1. Per-venture override wins if it points at a usable provider.
  if (venturePref) {
    const setting = settings.find((x) => x.provider === venturePref);
    if (setting && usable(setting)) return venturePref as LlmProviderId;
  }

  // 2. Global active provider.
  if (active) {
    const setting = settings.find((x) => x.provider === active);
    if (setting && usable(setting)) return active as LlmProviderId;
  }

  // 3. First enabled provider with valid auth (catalog order via listLlmSettings).
  for (const setting of settings) {
    if (usable(setting)) return setting.provider as LlmProviderId;
  }

  return null;
}
