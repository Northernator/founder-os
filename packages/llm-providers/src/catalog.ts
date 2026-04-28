import type {
  LlmProviderCatalogEntry,
  LlmProviderId,
} from "./types.js";

/**
 * Single source of truth for every LLM backend we support.
 *
 * The Options UI renders one row per entry; the Rust `llm_stream` command
 * dispatches on `kind`. Base URLs and default models can be overridden
 * per-install via the `llm_settings` table, so values here are just defaults.
 *
 * Notes on specific providers:
 *  - DeepSeek, Grok, Kimi, Perplexity all expose an OpenAI-compatible
 *    `/v1/chat/completions` endpoint, so they share the openai_compatible kind.
 *  - Ollama has a native `/api/chat` shape AND an OpenAI-compatible `/v1` shim.
 *    We use the v1 shim so the same Rust branch handles it.
 *  - Anthropic uses its own `/v1/messages` shape + `x-api-key` header.
 *  - Gemini uses `:streamGenerateContent` with `?alt=sse` and a different
 *    role naming convention (`user`/`model`), handled in its own branch.
 */
export const PROVIDER_CATALOG: readonly LlmProviderCatalogEntry[] = [
  {
    id: "anthropic",
    displayName: "Anthropic Claude",
    blurb: "Founder OS's default — great at long documents, code review, business reasoning.",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    modelSuggestions: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-opus-4-6",
    requiresApiKey: true,
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    // Anthropic's server-side web_search_20250305 tool. Enabled per-request
    // via streamChat({ enableWebSearch: true }). See llm.rs stream_anthropic.
    supportsWebSearch: true,
  },
  {
    id: "openai",
    displayName: "OpenAI",
    blurb: "GPT family. Use for broad general-purpose reasoning and tool-use.",
    kind: "openai_compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelSuggestions: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1"],
    defaultModel: "gpt-4o",
    requiresApiKey: true,
    apiKeyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    blurb: "Multimodal, long context (1M+ tokens on 1.5/2.x). Good for doc-heavy research.",
    kind: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelSuggestions: [
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    defaultModel: "gemini-2.0-flash",
    requiresApiKey: true,
    apiKeyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    blurb: "Low-cost frontier reasoning. OpenAI-compatible API.",
    kind: "openai_compatible",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    modelSuggestions: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    requiresApiKey: true,
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "grok",
    displayName: "xAI Grok",
    blurb: "Real-time web knowledge and edgy tone. OpenAI-compatible.",
    kind: "openai_compatible",
    defaultBaseUrl: "https://api.x.ai/v1",
    modelSuggestions: ["grok-3", "grok-3-mini", "grok-2-latest"],
    defaultModel: "grok-3",
    requiresApiKey: true,
    apiKeyUrl: "https://console.x.ai",
  },
  {
    id: "kimi",
    displayName: "Moonshot Kimi",
    blurb: "Very long context Chinese/EN model. OpenAI-compatible.",
    kind: "openai_compatible",
    // Moonshot has a .ai endpoint for international traffic; users inside CN
    // may need to override to api.moonshot.cn in the Options tab.
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    modelSuggestions: [
      "kimi-k2-0711-preview",
      "moonshot-v1-128k",
      "moonshot-v1-32k",
      "moonshot-v1-8k",
    ],
    defaultModel: "kimi-k2-0711-preview",
    requiresApiKey: true,
    apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    blurb: "Search-grounded answers with citations. OpenAI-compatible (Sonar models).",
    kind: "openai_compatible",
    defaultBaseUrl: "https://api.perplexity.ai",
    modelSuggestions: [
      "sonar-pro",
      "sonar",
      "sonar-reasoning-pro",
      "sonar-reasoning",
    ],
    defaultModel: "sonar-pro",
    requiresApiKey: true,
    apiKeyUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "ollama",
    displayName: "Ollama (local)",
    blurb: "Runs models on your own machine. Start Ollama, pull a model, then pick it here.",
    kind: "openai_compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    modelSuggestions: ["llama3.2", "llama3.1", "qwen2.5", "mistral", "phi4"],
    defaultModel: "llama3.2",
    requiresApiKey: false,
  },
] as const;

const CATALOG_BY_ID: Record<LlmProviderId, LlmProviderCatalogEntry> =
  Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p])) as Record<
    LlmProviderId,
    LlmProviderCatalogEntry
  >;

/** Lookup helper — guaranteed non-null for any `LlmProviderId`. */
export function getProvider(id: LlmProviderId): LlmProviderCatalogEntry {
  return CATALOG_BY_ID[id];
}

export const PROVIDER_IDS: readonly LlmProviderId[] = PROVIDER_CATALOG.map(
  (p) => p.id
);
