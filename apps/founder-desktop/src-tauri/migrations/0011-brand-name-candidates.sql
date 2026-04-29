-- 0011 — persistent triage list for generated brand name candidates
--
-- The Brand tab generates batches of names via streamed LLM calls and
-- previously dropped any candidate the user didn't pick. This table
-- captures every generated name so the user can triage names across
-- regeneration runs and remember WHY a rejected name was rejected
-- without re-paying the compute cost.
--
-- Columns:
--   venture_id  Foreign-key-ish pointer to ventures.id. Not declared as
--               a real FK because the ventures table lives in a
--               separate migration and we don't want a delete cascade
--               to silently nuke the user's triage history; if a
--               venture is deleted the rows linger, which is fine.
--   name        Candidate name as the LLM returned it (already trimmed
--               on the TS side).
--   info_json   Full NamingCandidate payload as JSON. Stored verbatim
--               so the renderer can show whatever metadata brand-gen
--               wrote — domain status, trademark status, rationale,
--               style — without a parallel column for each field.
--   status      Triage state: 'new' (just generated, undecided),
--               'possible' (founder thinks this might work),
--               'fail' (rejected — kept so we don't waste tokens
--               re-suggesting it). Defaults to 'new'.
--   created_at  ISO-8601 UTC. When the row was first inserted.
--   decided_at  ISO-8601 UTC, NULL until the user moves the row out of
--               'new'. Used to order the possible/fail sections by
--               most-recent-decision first.
--
-- UNIQUE(venture_id, name) is the dedup key. The Tauri handler uses
-- INSERT OR IGNORE so a regeneration run that produces an already-known
-- name is a no-op — the existing status stays put. If we ever want a
-- "refresh research on this name" affordance it goes through a
-- separate explicit command, not through generation.
CREATE TABLE brand_name_candidates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venture_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  info_json   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  UNIQUE(venture_id, name)
);

-- The list view is always filtered by venture_id and grouped by status
-- (POSSIBLE / NEW / FAIL sections). This composite index serves both
-- the per-section selects and the unique-key lookup inside the upsert
-- command.
CREATE INDEX idx_brand_names_venture_status
  ON brand_name_candidates(venture_id, status);
