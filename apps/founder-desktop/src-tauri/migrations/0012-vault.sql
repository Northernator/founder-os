-- 0012 — Dream Vault schema (the Rust-arc slice 1 fix for the misplaced
-- vault migration originally landed at packages/db/src/migrations/
-- 0002-vault.sql by the DREAM_VAULT_MODULE arc. That file lived in the
-- npm @founder-os/db package's migrations directory, which the Tauri
-- app never reads — Tauri loads SQL exclusively from this directory via
-- include_str! in lib.rs. Without this file, no vault command can
-- succeed because the tables don't exist.
--
-- Filesystem under <workspace>/_vault/ is the canonical source for vault
-- artefacts; SQLite holds the lightweight index the UI polls.

CREATE TABLE IF NOT EXISTS vault_import_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_import_jobs_status_idx ON vault_import_jobs(status);
CREATE INDEX IF NOT EXISTS vault_import_jobs_created_idx ON vault_import_jobs(created_at);

CREATE TABLE IF NOT EXISTS vault_source_documents (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES vault_import_jobs(id),
  source_type TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  file_extension TEXT,
  cached_original_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER,
  extraction_status TEXT NOT NULL,
  extraction_method TEXT,
  confidence TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  imported_at TEXT
);
CREATE INDEX IF NOT EXISTS vault_source_documents_job_idx ON vault_source_documents(import_job_id);
CREATE INDEX IF NOT EXISTS vault_source_documents_hash_idx ON vault_source_documents(content_hash);
CREATE INDEX IF NOT EXISTS vault_source_documents_status_idx ON vault_source_documents(extraction_status);

CREATE TABLE IF NOT EXISTS vault_source_extractions (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES vault_source_documents(id),
  extracted_text_path TEXT,
  extracted_markdown_path TEXT,
  summary TEXT,
  language TEXT,
  confidence TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_source_extractions_doc_idx ON vault_source_extractions(source_document_id);

CREATE TABLE IF NOT EXISTS vault_source_images (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES vault_source_documents(id),
  width INTEGER,
  height INTEGER,
  ocr_text TEXT,
  vision_summary TEXT,
  detected_layout_json TEXT,
  confidence TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_source_images_doc_idx ON vault_source_images(source_document_id);

CREATE TABLE IF NOT EXISTS vault_project_matches (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES vault_source_documents(id),
  project_id TEXT REFERENCES ventures(id),
  suggested_project_name TEXT,
  confidence TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_project_matches_doc_idx ON vault_project_matches(source_document_id);
CREATE INDEX IF NOT EXISTS vault_project_matches_project_idx ON vault_project_matches(project_id);
CREATE INDEX IF NOT EXISTS vault_project_matches_status_idx ON vault_project_matches(status);

CREATE TABLE IF NOT EXISTS vault_extracted_items (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES vault_source_documents(id),
  project_id TEXT REFERENCES ventures(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_extracted_items_doc_idx ON vault_extracted_items(source_document_id);
CREATE INDEX IF NOT EXISTS vault_extracted_items_project_idx ON vault_extracted_items(project_id);
CREATE INDEX IF NOT EXISTS vault_extracted_items_type_idx ON vault_extracted_items(type);
CREATE INDEX IF NOT EXISTS vault_extracted_items_status_idx ON vault_extracted_items(status);

CREATE TABLE IF NOT EXISTS vault_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES ventures(id),
  source_document_id TEXT NOT NULL REFERENCES vault_source_documents(id),
  title TEXT NOT NULL,
  note_type TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_notes_project_idx ON vault_notes(project_id);
CREATE INDEX IF NOT EXISTS vault_notes_doc_idx ON vault_notes(source_document_id);
CREATE INDEX IF NOT EXISTS vault_notes_type_idx ON vault_notes(note_type);

CREATE TABLE IF NOT EXISTS vault_cloud_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_email TEXT NOT NULL,
  connection_status TEXT NOT NULL,
  token_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS vault_cloud_connections_provider_idx ON vault_cloud_connections(provider);

CREATE TABLE IF NOT EXISTS vault_import_sources (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES vault_import_jobs(id),
  source_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  external_name TEXT NOT NULL,
  external_mime_type TEXT,
  external_path TEXT,
  external_url TEXT,
  local_cached_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_import_sources_job_idx ON vault_import_sources(import_job_id);
CREATE INDEX IF NOT EXISTS vault_import_sources_hash_idx ON vault_import_sources(hash);
