/**
 * Drizzle + SQLite provider -- TIER_4 STUB. Slice 2 of the backend arc.
 *
 * Drizzle + SQLite is the DIY tier. ORM + raw SQLite, no admin UI, no built-in auth, no realtime. The user builds everything PocketBase gives for free. Useful only when a full BaaS is overkill (embedded apps, CLI tools, anything where SQLite-in-a-file is the whole backend story).
 *
 * SLICE 2 IS A STUB. `available()` returns false and `provision()` /
 * `applySchema()` / `export()` throw DrizzleSqliteNotImplementedError with a
 * helpful pointer at what slice 7+ would need to wire up. The factory +
 * options shape is locked so future implementors only touch the
 * internals of the methods, not the public surface.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  *  - On applySchema(): translate Collection -> Drizzle schema.ts
 *    + write under 12_backend/drizzle/schema.ts. Drizzle Kit's
 *    `generate:sqlite` then produces the migration SQL.
 *  - On provision(): nothing to do -- SQLite is a file. The
 *    instance.baseUrl is undefined (no HTTP).
 *  - On export(): emit BackendExport with engine='drizzle_sqlite',
 *    sdk.importPath pointing at the generated Drizzle client.
 *
 * The resolver in @founder-os/backend-providers/node will skip this
 * provider as long as available() returns false, which it does until
 * the implementation lands.
 */
import type {
  ApplySchemaOpts,
  BackendExport,
  BackendInstance,
  BackendProvider,
  Collection,
  ProvisionOpts,
} from "@founder-os/backend-core";

export interface DrizzleSqliteProviderOpts {
  /**
   * Path to the SQLite file under 12_backend/. Defaults to data.db.
   */
  databaseFile?: string;
  /**
   * Where Drizzle Kit emits SQL migrations. Defaults to 12_backend/drizzle/migrations.
   */
  migrationsDir?: string;
}

export class DrizzleSqliteNotImplementedError extends Error {
  override readonly name = "DrizzleSqliteNotImplementedError";
  constructor(method: string) {
    super(
      `Drizzle + SQLite.${method}() is a stub. Slice 7+ ships the real implementation; ` +
        "until then this engine is skipped by the resolver via available()=false."
    );
  }
}

export function createDrizzleSqliteProvider(_opts: DrizzleSqliteProviderOpts = {}): BackendProvider {
  return {
    name: "drizzle_sqlite" as const,

    async available() {
      return false;
    },

    async provision(_provisionOpts: ProvisionOpts): Promise<BackendInstance> {
      throw new DrizzleSqliteNotImplementedError("provision");
    },

    async applySchema(_applyOpts: ApplySchemaOpts): Promise<void> {
      throw new DrizzleSqliteNotImplementedError("applySchema");
    },

    async export(
      _instance: BackendInstance,
      _collections: Collection[]
    ): Promise<BackendExport> {
      throw new DrizzleSqliteNotImplementedError("export");
    },
  };
}
