import { scanVentureArtifacts } from "./scanner.js";
import { createLogger } from "@founder-os/logger";

const log = createLogger("artifacts-index:sync");

/**
 * Minimal DB handle shape this module needs: an async `run(sql, params)`.
 * This matches the `@tauri-apps/plugin-sql` Database API (what the desktop
 * app uses) and can also be satisfied by a thin async wrapper over
 * better-sqlite3. Pinning a concrete type here would couple the package
 * to one driver — we don't want that until the wiring is decided.
 */
export type ArtifactsDbHandle = {
  run(sql: string, params?: unknown[]): Promise<unknown>;
};

export type SyncResult = {
  ventureId: string;
  scanned: number;
  inserted: number;
  skipped: number;
};

/**
 * Scan the venture workspace and upsert discovered artifacts into the DB.
 * This is idempotent — re-scanning the same files is safe.
 */
export async function syncArtifactsToDb(
  db: ArtifactsDbHandle,
  ventureId: string,
  ventureRoot: string
): Promise<SyncResult> {
  const refs = scanVentureArtifacts(ventureId, ventureRoot);
  let inserted = 0;
  let skipped = 0;

  for (const ref of refs) {
    try {
      // Use the artifacts-repo upsert — it's idempotent on artifactId
      await db.run(
        `INSERT OR IGNORE INTO artifacts (id, venture_id, type, path, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [ref.artifactId, ventureId, ref.type, ref.path]
      );
      inserted++;
    } catch {
      skipped++;
    }
  }

  log.info(`Sync complete for ${ventureId}: ${inserted} inserted, ${skipped} skipped`);
  return { ventureId, scanned: refs.length, inserted, skipped };
}
