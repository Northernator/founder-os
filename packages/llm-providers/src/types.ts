/**
 * Canonical identifiers for every LLM backend Founder OS knows how to talk to.
 *
 * Adding a new provider is a two-step change: add the id here and a matching
 * entry in `catalog.ts`. The Rust side (`llm_stream` command) dispatches on the
 * `kind` field of the catalog entry — no new Rust code is needed if the
 * provider is OpenAI-compatible.
 */
export type LlmProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "grok"
  | "kimi"
  | "perplexity"
  | "ollama";

/**
 * Wire protocol for a provider. Three Rust branches cover all eight providers
 * because the OpenAI-compatible flavour covers six of them (OpenAI itself,
 * DeepSeek, Grok/xAI, Kimi/Moonshot, Perplexity, and Ollama's `/v1` shim).
 */
export type LlmProviderKind = "anthropic" | "openai_compatible" | "gemini";

export type LlmProviderCatalogEntry = {
  id: LlmProviderId;
  displayName: string;
  /** Short description shown under the provider name in the Options tab. */
  blurb: string;
  kind: LlmProviderKind;
  /** Default base URL (can be overridden per-install, e.g. a self-hosted gateway). */
  defaultBaseUrl: string;
  /** Suggested models, newest/most-capable first. User can type a custom one. */
  modelSuggestions: readonly string[];
  /** Default model chosen on first save if the user doesn't pick one. */
  defaultModel: string;
  /**
   * Whether this provider needs an API key. Ollama runs locally and does not.
   * When false, the Options UI hides the key input.
   */
  requiresApiKey: boolean;
  /** Where to go to grab a key. Used as a small "get a key" link next to the input. */
  apiKeyUrl?: string;
  /**
   * Server-side web search. Anthropic supports this natively via the
   * `web_search_20250305` tool — the model decides when to search, Anthropic
   * runs the query and injects results inline, results and citations come
   * back in the same SSE stream. Setting this true lets the caller opt in
   * per request via `streamChat({ enableWebSearch: true })`.
   *
   * OpenAI and Gemini have separate web-search integrations with different
   * surfaces; those aren't wired up yet. Leave false for those providers
   * until we add them.
   */
  supportsWebSearch?: boolean;
};

/**
 * A single turn in the provider-agnostic chat format. The Rust side maps this
 * to each provider's native shape (role renames for Gemini, system-vs-messages
 * split for Anthropic, etc.).
 */
export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Request body for a streaming chat call, sent from TS to Rust via invoke. */
export type LlmStreamRequest = {
  /** Correlates stream events to the call site — generated client-side per send. */
  requestId: string;
  provider: LlmProviderId;
  /** Resolved at call time from `llm_settings`. */
  apiKey: string | null;
  /** Resolved at call time; `null` means "use the provider default". */
  baseUrl: string | null;
  model: string;
  messages: LlmMessage[];
  /** Optional system prompt. If omitted and the messages array already has a
   *  `system` message, the Rust side uses that instead. */
  system?: string;
  /** Upper bound on completion tokens. Providers that don't support it ignore. */
  maxTokens?: number;
  /** 0.0 – 1.0. Providers that don't support it ignore. */
  temperature?: number;
  /**
   * Opt in to server-side web search on providers that support it (today:
   * Anthropic only). When true and the provider supports it, the Rust side
   * attaches the provider-native web search tool to the request. When the
   * provider doesn't support it this flag is silently ignored — callers
   * don't need to branch on provider.
   */
  enableWebSearch?: boolean;
  /** Upper bound on web searches per request. Defaults to 5 when unset. */
  webSearchMaxUses?: number;
};

/**
 * Event payloads emitted by the Rust `llm_stream` command. Consumers listen via
 * `@tauri-apps/api/event` on the channel names below and filter by `requestId`.
 *
 * Channels:
 *  - `llm-delta` : a partial token/chunk arrived
 *  - `llm-done`  : stream closed cleanly; `text` is the full concatenated text
 *  - `llm-error` : stream closed with an error
 */
export type LlmDeltaEvent = {
  requestId: string;
  delta: string;
};
export type LlmDoneEvent = {
  requestId: string;
  text: string;
};
export type LlmErrorEvent = {
  requestId: string;
  message: string;
};
