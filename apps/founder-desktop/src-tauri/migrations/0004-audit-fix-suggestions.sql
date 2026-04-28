-- Cached AI fix suggestions for audit findings.
--
-- Goal: avoid burning tokens on a re-ask when the user's already had a
-- suggestion generated for a finding. 1:1 side table keyed on
-- finding_id. `INSERT OR REPLACE` means "Ask again" just overwrites.
--
-- ON DELETE CASCADE ensures suggestions disappear automatically when
-- their finding is replaced on a subsequent pipeline run (audit findings
-- are keyed `${runId}-${index}` and replaced in-place, which triggers
-- the cascade on SQLite).
CREATE TABLE IF NOT EXISTS audit_fix_suggestions (
  finding_id TEXT PRIMARY KEY REFERENCES audit_findings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL
);
