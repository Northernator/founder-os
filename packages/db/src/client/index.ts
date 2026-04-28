import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { createLogger } from "@founder-os/logger";

const logger = createLogger("db");

export type FounderDb = BetterSQLite3Database<typeof schema>;

export interface DbConfig {
  /** Absolute path to the SQLite file. Use ":memory:" for tests. */
  filePath: string;
}

/**
 * Open (or create) the local SQLite database and return a typed Drizzle client.
 * Callers must call runMigrations() at startup unless the database file was
 * already initialized by a previous run.
 */
export function openDb(config: DbConfig): { db: FounderDb; sqlite: Database.Database } {
  const sqlite = new Database(config.filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  logger.info("db.opened", { filePath: config.filePath });
  return { db, sqlite };
}

export { schema };
