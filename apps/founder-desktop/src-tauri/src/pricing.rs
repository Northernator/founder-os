//! Per-million-token list prices for the providers + models we ship.
//!
//! Mirror of packages/llm-providers/src/pricing.ts. Prompt Master
//! aggregation runs in Rust (pm_event_stats) so we keep a parallel copy
//! here to avoid a TS round-trip per stats refresh. Update both files
//! when adding or repricing a model.
//!
//! Prices accurate as of 2026-04-28.
//!
//! Lookup is exact-match → prefix-match → fallback. The prefix scan
//! lets a runtime model id like "claude-opus-4-6-20260101" inherit the
//! family pricing of "claude-opus-4-6" without a release-day code
//! change. Fallback ($3 in / $15 out per MTok) is mid-range Anthropic
//! so unknown / NULL events don't render as $0 in the UI.
//!
//! `tokens_saved` from the event log represents input-token savings
//! ("what we didn't have to send"), so the aggregator multiplies by
//! `input_per_million_tokens / 1_000_000`. Output-side savings would
//! require tracking optimized response tokens, which we don't, so the
//! output rate is informational only.

#[derive(Clone, Copy)]
pub struct ModelPricing {
    pub provider: &'static str,
    pub model: &'static str,
    pub input_per_million_tokens: f64,
    /// Output rate. Currently unused — Prompt Master only tracks
    /// input-side savings ("what we didn't have to send"). Retained
    /// here for parity with the TS pricing.ts mirror so future
    /// response-token features have it ready.
    #[allow(dead_code)]
    pub output_per_million_tokens: f64,
}

pub const FALLBACK_PRICING: ModelPricing = ModelPricing {
    provider: "unknown",
    model: "unknown",
    input_per_million_tokens: 3.0,
    output_per_million_tokens: 15.0,
};

const MODEL_PRICING: &[ModelPricing] = &[
    // Anthropic
    ModelPricing { provider: "anthropic", model: "claude-opus-4-6", input_per_million_tokens: 15.0, output_per_million_tokens: 75.0 },
    ModelPricing { provider: "anthropic", model: "claude-sonnet-4-6", input_per_million_tokens: 3.0, output_per_million_tokens: 15.0 },
    ModelPricing { provider: "anthropic", model: "claude-haiku-4-5-20251001", input_per_million_tokens: 1.0, output_per_million_tokens: 5.0 },

    // OpenAI
    ModelPricing { provider: "openai", model: "gpt-4o", input_per_million_tokens: 2.5, output_per_million_tokens: 10.0 },
    ModelPricing { provider: "openai", model: "gpt-4o-mini", input_per_million_tokens: 0.15, output_per_million_tokens: 0.6 },
    ModelPricing { provider: "openai", model: "gpt-4-turbo", input_per_million_tokens: 10.0, output_per_million_tokens: 30.0 },
    ModelPricing { provider: "openai", model: "o1", input_per_million_tokens: 15.0, output_per_million_tokens: 60.0 },
    ModelPricing { provider: "openai", model: "o3-mini", input_per_million_tokens: 1.1, output_per_million_tokens: 4.4 },

    // Google Gemini
    ModelPricing { provider: "gemini", model: "gemini-2.5-pro", input_per_million_tokens: 1.25, output_per_million_tokens: 10.0 },
    ModelPricing { provider: "gemini", model: "gemini-2.5-flash", input_per_million_tokens: 0.3, output_per_million_tokens: 2.5 },
    ModelPricing { provider: "gemini", model: "gemini-2.0-flash", input_per_million_tokens: 0.1, output_per_million_tokens: 0.4 },
    ModelPricing { provider: "gemini", model: "gemini-1.5-pro", input_per_million_tokens: 1.25, output_per_million_tokens: 5.0 },
    ModelPricing { provider: "gemini", model: "gemini-1.5-flash", input_per_million_tokens: 0.075, output_per_million_tokens: 0.3 },

    // DeepSeek
    ModelPricing { provider: "deepseek", model: "deepseek-chat", input_per_million_tokens: 0.27, output_per_million_tokens: 1.1 },
    ModelPricing { provider: "deepseek", model: "deepseek-reasoner", input_per_million_tokens: 0.55, output_per_million_tokens: 2.19 },

    // xAI Grok
    ModelPricing { provider: "grok", model: "grok-3", input_per_million_tokens: 3.0, output_per_million_tokens: 15.0 },
    ModelPricing { provider: "grok", model: "grok-3-mini", input_per_million_tokens: 0.3, output_per_million_tokens: 0.5 },
    ModelPricing { provider: "grok", model: "grok-2", input_per_million_tokens: 2.0, output_per_million_tokens: 10.0 },
    ModelPricing { provider: "grok", model: "grok-2-mini", input_per_million_tokens: 0.2, output_per_million_tokens: 1.0 },

    // Moonshot Kimi
    ModelPricing { provider: "kimi", model: "kimi-k2-0711-preview", input_per_million_tokens: 0.6, output_per_million_tokens: 2.5 },
    ModelPricing { provider: "kimi", model: "moonshot-v1-128k", input_per_million_tokens: 8.4, output_per_million_tokens: 8.4 },
    ModelPricing { provider: "kimi", model: "moonshot-v1-32k", input_per_million_tokens: 3.5, output_per_million_tokens: 3.5 },
    ModelPricing { provider: "kimi", model: "moonshot-v1-8k", input_per_million_tokens: 1.7, output_per_million_tokens: 1.7 },

    // Perplexity
    ModelPricing { provider: "perplexity", model: "sonar-pro", input_per_million_tokens: 3.0, output_per_million_tokens: 15.0 },
    ModelPricing { provider: "perplexity", model: "sonar", input_per_million_tokens: 1.0, output_per_million_tokens: 1.0 },
    ModelPricing { provider: "perplexity", model: "sonar-reasoning-pro", input_per_million_tokens: 2.0, output_per_million_tokens: 8.0 },
    ModelPricing { provider: "perplexity", model: "sonar-reasoning", input_per_million_tokens: 1.0, output_per_million_tokens: 5.0 },

    // Ollama — local, $0 marginal cost.
    ModelPricing { provider: "ollama", model: "llama3.1:70b", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
    ModelPricing { provider: "ollama", model: "llama3.2", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
    ModelPricing { provider: "ollama", model: "llama3.1", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
    ModelPricing { provider: "ollama", model: "qwen2.5", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
    ModelPricing { provider: "ollama", model: "mistral", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
    ModelPricing { provider: "ollama", model: "phi4", input_per_million_tokens: 0.0, output_per_million_tokens: 0.0 },
];

/// Resolve pricing for a (provider, model) pair.
///
/// Match order: exact → longest-prefix on the same provider → fallback.
/// `None` for either input collapses straight to fallback so legacy NULL
/// rows from migrations 0008/0009 don't show as $0.
pub fn get_pricing(provider: Option<&str>, model: Option<&str>) -> ModelPricing {
    let (Some(prov), Some(m)) = (provider, model) else {
        return FALLBACK_PRICING;
    };

    // Exact hit.
    for p in MODEL_PRICING {
        if p.provider == prov && p.model == m {
            return *p;
        }
    }

    // Longest-prefix hit on the same provider. Lets dated snapshots
    // ("claude-opus-4-6-20260101") inherit the family rate.
    let mut best: Option<&ModelPricing> = None;
    for p in MODEL_PRICING {
        if p.provider != prov {
            continue;
        }
        if m.starts_with(p.model) {
            if let Some(existing) = best {
                if p.model.len() > existing.model.len() {
                    best = Some(p);
                }
            } else {
                best = Some(p);
            }
        }
    }
    best.copied().unwrap_or(FALLBACK_PRICING)
}

/// Convert input-token savings into USD using the resolved input rate.
/// Output rate is informational — savings only apply to what we
/// avoided sending, never to the response side.
pub fn dollars_for_tokens_saved(provider: Option<&str>, model: Option<&str>, tokens_saved: i64) -> f64 {
    if tokens_saved <= 0 {
        return 0.0;
    }
    let pricing = get_pricing(provider, model);
    (tokens_saved as f64) * pricing.input_per_million_tokens / 1_000_000.0
}
