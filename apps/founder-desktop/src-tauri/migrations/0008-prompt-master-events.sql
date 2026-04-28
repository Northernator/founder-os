-- 0008 — persistent telemetry log for Prompt Master events
--
-- The TS-side @founder-os/prompt-master library exposes a TelemetrySink
-- interface (emit). The browser default is a no-op sink, which means
-- per-call optimisation stats are lost the moment the window closes —
-- the only persistent surface we had was the Node-only ndjson appender
-- in @founder-os/prompt-master/node, which the desktop WebView can't
-- import (see biome.json restriction).
--
-- This table backs a Tauri-side sink so the Options tab can show
-- lifetime stats (tokens saved, cache hit rate, top contexts) without
-- shelling out to the CLI. A new row is INSERTed for every emit; reads
-- happen on Options-tab mount + every 30s while visible + on Refresh.
--
-- Columns:
--   id            Surrogate key. Used by the eviction sweep that keeps
--                 the table at <=10000 rows (DELETE WHERE id NOT IN
--                 (... ORDER BY id DESC LIMIT 10000)).
--   ts            ISO-8601 UTC timestamp of the event. Indexed for any
--                 future "events in last N days" query.
--   event         'optimize' | 'fallback'. Mapped from the
--                 TelemetryEvent.event discriminator
--                 ('prompt_master.optimize' / 'prompt_master.fallback')
--                 with the prefix stripped so existing CLI tooling that
--                 emits the unprefixed form keeps working.
--   context       The PromptContext string ("venture-chat", "handoff",
--                 ...). Indexed because top-contexts grouping reads
--                 tokens_saved per context.
--   tokens_saved  Cumulative summand for the lifetime tokens-saved
--                 number. Always 0 for fallback events.
--   cache_hit     0 or 1. Used by the cache-hit-rate ratio over
--                 optimize events only.
--   transport     "cache" | "claude-cli" | "anthropic-fetch" | … —
--                 nullable because fallback events don't carry one.
--   latency_ms    nullable for fallback events.
CREATE TABLE prompt_master_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  event        TEXT NOT NULL,
  context      TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  cache_hit    INTEGER NOT NULL DEFAULT 0,
  transport    TEXT,
  latency_ms   INTEGER
);

CREATE INDEX idx_pm_events_ts ON prompt_master_events(ts);
CREATE INDEX idx_pm_events_context ON prompt_master_events(context);
