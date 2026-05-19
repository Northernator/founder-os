import { createLogger } from "@founder-os/logger";
import type Database from "better-sqlite3";

const logger = createLogger("db.migrations");

/**
 * Migrations are inlined as strings so the package ships as pure JS and doesn't
 * need to read from disk at runtime. When adding a new one, append to MIGRATIONS
 * with a higher version number.
 */
const MIGRATION_0001_INIT = `
CREATE TABLE IF NOT EXISTS ventures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ventures_slug_idx ON ventures(slug);
CREATE INDEX IF NOT EXISTS ventures_stage_idx ON ventures(stage);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id),
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  derived_from_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS artifacts_venture_idx ON artifacts(venture_id);
CREATE INDEX IF NOT EXISTS artifacts_type_idx ON artifacts(type);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_venture_idx ON runs(venture_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);

CREATE TABLE IF NOT EXISTS audit_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  venture_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  file_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_run_idx ON audit_findings(run_id);
CREATE INDEX IF NOT EXISTS findings_severity_idx ON audit_findings(severity);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id),
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_thread_idx ON chat_messages(thread_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_venture_idx ON tasks(venture_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
`;

/**
 * Slice 1 of DREAM_VAULT_MODULE arc. 9 tables for the import-job pipeline +
 * vault index. Filesystem under <workspace>/_vault/ is the canonical store;
 * SQLite is purely the lightweight queryable index the UI polls.
 */
const MIGRATION_0002_VAULT = `
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
`;

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "init", sql: MIGRATION_0001_INIT },
  { version: 2, name: "vault", sql: MIGRATION_0002_VAULT },
];

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  );
  const applied = sqlite.prepare("SELECT version FROM _migrations").all() as { version: number }[];
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (appliedVersions.has(m.version)) continue;
    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .prepare("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, new Date().toISOString());
    });
    tx();
    logger.info("db.migration.applied", { version: m.version, name: m.name });
  }
}
