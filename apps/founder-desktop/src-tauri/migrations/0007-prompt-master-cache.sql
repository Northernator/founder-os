-- 0007 — persistent cache for Prompt Master optimised prompts
--
-- The TS-side @founder-os/prompt-master library has a pluggable
-- CacheBackend interface. The browser default is in-memory, which means
-- every window close burns the cache and the next session re-runs the
-- optimizer on prompts it has already seen. This table is the desktop
-- app's persistent backing store: a CacheBackend implementation in
-- apps/founder-desktop/src/lib/prompt-master-tauri-cache.ts proxies
-- get/put/inspect to the Tauri commands in src-tauri/src/cache.rs,
-- which talk to this table.
--
-- Columns:
--   hash       SHA-256-shaped key produced by hashKey() in the
--              prompt-master package. Primary key — entries are 1:1
--              with their hash.
--   optimized  The optimized prompt body. Read on cache hit.
--   stored_at  ISO-8601 UTC timestamp (when the entry was last written).
--              Used to surface an "age" if we ever build a debug panel.
--   bytes      UTF-8 byte length of `optimized`. Stored explicitly so
--              the eviction policy in `pm_cache_put` can sum bytes
--              without scanning every row's content. Matches what
--              CacheBackend.put() computes on the TS side.
--   last_used  ISO-8601 UTC. Updated on every cache hit; the eviction
--              path picks the bottom 10% by last_used ASC when the cache
--              total exceeds the cap (200MB). LRU semantics, not LFU,
--              because system prompts churn slowly and recency is a
--              cleaner predictor than hit count.
CREATE TABLE prompt_master_cache (
  hash       TEXT PRIMARY KEY,
  optimized  TEXT NOT NULL,
  stored_at  TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  last_used  TEXT NOT NULL
);

-- Index on last_used to keep the eviction sweep cheap. The eviction
-- query is `... ORDER BY last_used ASC LIMIT N` and runs inside every
-- pm_cache_put call when the cap is exceeded; without this index it
-- would full-scan the table.
CREATE INDEX idx_prompt_master_cache_last_used
  ON prompt_master_cache(last_used);
