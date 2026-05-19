-- 0013 — vault_note_drafts table for resumable vault imports.
--
-- The Dream Vault arc held draft notes in renderer memory only: the
-- VaultStageRunner emits `VaultNoteDraft` objects after the LLM /
-- heuristic extraction pass; the review screen renders them; on
-- commit the markdown lands on disk. A reload between phase 9 and
-- commit lost the drafts because nothing persisted them.
--
-- This migration adds the missing table so the resumable-imports arc
-- can boot-hydrate the full review state (sources + matches + items +
-- drafts) from SQLite. Once that arc ships, recovered jobs that
-- previously could only be discarded can be reviewed and committed
-- end-to-end across sessions.
--
-- Column notes:
--   suggested_venture_slug : populated by the project-classifier when
--                            confidence is high enough; null otherwise.
--                            The reviewer can override at commit time.
--   preview_content         : the pre-rendered markdown body. Storing
--                            it verbatim means we don't need to re-run
--                            template rendering on resume.
--   preview_frontmatter_json: full VaultNoteFrontmatter as JSON. Same
--                            "stored verbatim" rationale as above.
--   item_ids_json / tags_json: nested string arrays.
--   variables_json          : the template variable bag the runner
--                            built. Needed when finalize() wants to
--                            re-render with a different slug.
CREATE TABLE IF NOT EXISTS vault_note_drafts (
  id                          TEXT PRIMARY KEY,
  import_job_id               TEXT NOT NULL REFERENCES vault_import_jobs(id),
  source_document_id          TEXT NOT NULL REFERENCES vault_source_documents(id),
  note_type                   TEXT NOT NULL,
  suggested_venture_slug      TEXT,
  title                       TEXT NOT NULL,
  preview_content             TEXT NOT NULL,
  preview_frontmatter_json    TEXT NOT NULL,
  item_ids_json               TEXT NOT NULL DEFAULT '[]',
  tags_json                   TEXT NOT NULL DEFAULT '[]',
  confidence                  TEXT,
  variables_json              TEXT NOT NULL DEFAULT '{}',
  created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_note_drafts_job_idx ON vault_note_drafts(import_job_id);
CREATE INDEX IF NOT EXISTS vault_note_drafts_source_idx ON vault_note_drafts(source_document_id);
