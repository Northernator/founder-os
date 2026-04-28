-- 0002 — LLM provider settings
--
-- `llm_settings` holds one row per provider (anthropic / openai / gemini / …).
-- Keys are global (not per-venture) — the intent is a single user pasting their
-- API keys once. Upgrade path: when we add OS-keychain storage we drop the
-- `api_key` column here and store a handle/alias instead.
--
-- `app_settings` is a generic key/value table for misc app-wide prefs like
-- `active_provider`. Cheaper than a dedicated column-per-setting schema.
CREATE TABLE IF NOT EXISTS llm_settings (
  provider TEXT PRIMARY KEY,
  api_key TEXT,
  base_url TEXT,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
