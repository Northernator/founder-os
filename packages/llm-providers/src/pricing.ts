/**
 * Per-million-token list prices for the providers + models in PROVIDER_CATALOG.
 *
 * Prices accurate as of 2026-04-28. Refresh when a provider posts new
 * pricing or when we add a model to the catalog. Source: each provider's
 * public pricing page (links live on each catalog entry).
 *
 * Why a flat array instead of a nested map: the helper supports prefix
 * matching ("claude-opus-4-6-20260101" -> "claude-opus-4-6") and a
 * deterministic fallback, both of which are easier to express against a
 * linear list than against a Record<provider, Record<model, …>>.
 *
 * Tokens here means provider-billed tokens. Prompt Master estimates with
 * `estimateTokens()` (~chars/4) so the dollar numbers are approximate —
 * they're "tokens we didn't send" × list price, not actual invoice deltas.
 *
 * Mirror in Rust: apps/founder-desktop/src-tauri/src/pricing.rs holds the
 * same table for the pm_event_stats aggregation. Update both when adding
 * or repricing a model.
 */

export interface ModelPricing {
  provider: string;
  model: string;
  /** USD per 1,000,000 input tokens (what the user sends). */
  inputPerMillionTokens: number;
  /** USD per 1,000,000 output tokens (what the model returns). */
  outputPerMillionTokens: number;
}

/**
 * Fallback price used when (provider, model) doesn't match any row.
 * Mid-range Anthropic-ish so unknown / legacy events don't render as $0
 * (which would make Prompt Master's savings look fake) and don't blow
 * up to GPT-4-class numbers (which would over-promise).
 */
export const FALLBACK_PRICING: ModelPricing = {
  provider: "unknown",
  model: "unknown",
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
};

export const MODEL_PRICING: ModelPricing[] = [
  // Anthropic — https://www.anthropic.com/pricing
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    inputPerMillionTokens: 15,
    outputPerMillionTokens: 75,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 5,
  },

  // OpenAI — https://openai.com/api/pricing/
  { provider: "openai", model: "gpt-4o", inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPerMillionTokens: 0.15,
    outputPerMillionTokens: 0.6,
  },
  {
    provider: "openai",
    model: "gpt-4-turbo",
    inputPerMillionTokens: 10,
    outputPerMillionTokens: 30,
  },
  { provider: "openai", model: "o1", inputPerMillionTokens: 15, outputPerMillionTokens: 60 },
  { provider: "openai", model: "o3-mini", inputPerMillionTokens: 1.1, outputPerMillionTokens: 4.4 },

  // Google Gemini — https://ai.google.dev/pricing
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 10,
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    inputPerMillionTokens: 0.3,
    outputPerMillionTokens: 2.5,
  },
  {
    provider: "gemini",
    model: "gemini-2.0-flash",
    inputPerMillionTokens: 0.1,
    outputPerMillionTokens: 0.4,
  },
  {
    provider: "gemini",
    model: "gemini-1.5-pro",
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 5,
  },
  {
    provider: "gemini",
    model: "gemini-1.5-flash",
    inputPerMillionTokens: 0.075,
    outputPerMillionTokens: 0.3,
  },

  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing
  {
    provider: "deepseek",
    model: "deepseek-chat",
    inputPerMillionTokens: 0.27,
    outputPerMillionTokens: 1.1,
  },
  {
    provider: "deepseek",
    model: "deepseek-reasoner",
    inputPerMillionTokens: 0.55,
    outputPerMillionTokens: 2.19,
  },

  // xAI Grok — https://docs.x.ai/docs/models
  { provider: "grok", model: "grok-3", inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
  {
    provider: "grok",
    model: "grok-3-mini",
    inputPerMillionTokens: 0.3,
    outputPerMillionTokens: 0.5,
  },
  { provider: "grok", model: "grok-2", inputPerMillionTokens: 2, outputPerMillionTokens: 10 },
  { provider: "grok", model: "grok-2-mini", inputPerMillionTokens: 0.2, outputPerMillionTokens: 1 },

  // Moonshot Kimi — https://platform.moonshot.ai/docs/pricing
  {
    provider: "kimi",
    model: "kimi-k2-0711-preview",
    inputPerMillionTokens: 0.6,
    outputPerMillionTokens: 2.5,
  },
  {
    provider: "kimi",
    model: "moonshot-v1-128k",
    inputPerMillionTokens: 8.4,
    outputPerMillionTokens: 8.4,
  },
  {
    provider: "kimi",
    model: "moonshot-v1-32k",
    inputPerMillionTokens: 3.5,
    outputPerMillionTokens: 3.5,
  },
  {
    provider: "kimi",
    model: "moonshot-v1-8k",
    inputPerMillionTokens: 1.7,
    outputPerMillionTokens: 1.7,
  },

  // Perplexity — https://docs.perplexity.ai/guides/pricing
  {
    provider: "perplexity",
    model: "sonar-pro",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  },
  { provider: "perplexity", model: "sonar", inputPerMillionTokens: 1, outputPerMillionTokens: 1 },
  {
    provider: "perplexity",
    model: "sonar-reasoning-pro",
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
  },
  {
    provider: "perplexity",
    model: "sonar-reasoning",
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 5,
  },

  // Ollama — local, self-hosted. No marginal token cost.
  {
    provider: "ollama",
    model: "llama3.1:70b",
    inputPerMillionTokens: 0,
    outputPerMillionTokens: 0,
  },
  { provider: "ollama", model: "llama3.2", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
  { provider: "ollama", model: "llama3.1", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
  { provider: "ollama", model: "qwen2.5", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
  { provider: "ollama", model: "mistral", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
  { provider: "ollama", model: "phi4", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
];

const PRICING_BY_KEY: Map<string, ModelPricing> = new Map(
  MODEL_PRICING.map((p) => [`${p.provider}::${p.model}`, p])
);

/**
 * Resolve pricing for a (provider, model) pair.
 *
 * Match order:
 *   1. Exact "<provider>::<model>" hit.
 *   2. Prefix hit — a row where the catalog model is a prefix of the
 *      runtime model id (e.g. catalog "claude-opus-4-6" matches a runtime
 *      "claude-opus-4-6-20260101"). This makes dated model snapshots
 *      inherit their family's price without a release-day code change.
 *   3. Fallback to FALLBACK_PRICING. Old events with NULL provider/model
 *      and never-seen models both land here, so neither shows as $0.
 */
export function getPricing(
  provider: string | undefined | null,
  model: string | undefined | null
): ModelPricing {
  if (!provider || !model) return FALLBACK_PRICING;

  const exact = PRICING_BY_KEY.get(`${provider}::${model}`);
  if (exact) return exact;

  // Prefix scan, longest match wins so "claude-opus-4-6" beats "claude" if
  // we ever add a generic family-level row.
  let best: ModelPricing | null = null;
  for (const p of MODEL_PRICING) {
    if (p.provider !== provider) continue;
    if (model.startsWith(p.model) && (best === null || p.model.length > best.model.length)) {
      best = p;
    }
  }
  return best ?? FALLBACK_PRICING;
}
