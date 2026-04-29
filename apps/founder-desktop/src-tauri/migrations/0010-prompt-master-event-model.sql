-- 0010 — capture provider + model on every Prompt Master event
--
-- Migrations 0008/0009 stored telemetry without knowing which LLM
-- backend actually ran each optimisation. The Options-tab stats card
-- shows "tokens saved" but can't translate that into dollar savings
-- because different models have wildly different per-token prices —
-- saving 1k tokens against gpt-4o-mini ($0.15/MTok) is nowhere near
-- saving the same 1k against claude-opus ($15/MTok).
--
-- Both columns are nullable on purpose. Existing rows pre-dating this
-- migration have no (provider, model) attribution and the dollar
-- aggregation in pm_event_stats maps them to the unknown-pricing
-- fallback bucket — they keep contributing to lifetime token totals
-- but their dollar contribution is a midrange estimate, not zero.
-- Cache-hit events also write NULL here: the cached entry was
-- populated by some earlier call and we don't track which model
-- produced it, so the same fallback applies.
--
-- The composite index is for the per-(provider, model) GROUP BY in
-- the stats query. SQLite can use the leading prefix (provider) for
-- top-models aggregation and the full key for the join inside the
-- top-ventures query. Cardinality is tiny — at most ~30 rows even on
-- a power user's install — so the index pays for itself many times
-- over.
ALTER TABLE prompt_master_events ADD COLUMN provider TEXT;
ALTER TABLE prompt_master_events ADD COLUMN model TEXT;
CREATE INDEX idx_pm_events_model ON prompt_master_events(provider, model);
