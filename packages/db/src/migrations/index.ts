import type Database from "better-sqlite3";
import { createLogger } from "@founder-os/logger";

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

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "init", sql: MIGRATION_0001_INIT },
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
