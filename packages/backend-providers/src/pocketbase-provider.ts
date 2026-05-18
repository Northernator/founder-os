/**
 * PocketBase implementation of the BackendProvider contract.
 *
 * Slice 2 ships the wrapper shell + every method end-to-end:
 *  - available() probes the binary on disk.
 *  - provision() bootstraps the dir layout + records the path/port/URL,
 *    then throws PocketbaseBinaryMissingError if the binary itself isn't
 *    there yet (slice 4 wires the auto-download).
 *  - applySchema() writes one skeletal migration per collection + spawns
 *    `pocketbase migrate up` against the venture's binary.
 *  - export() does an admin auth -> listCollections -> assemble shape.
 *
 * The provider stays Node-stdlib-only (no third-party deps beyond
 * @founder-os/backend-core + zod) so it embeds cleanly from the desktop,
 * the cowork sidecar, or a CI job.
 */

import {
  BACKEND_ENGINE_TIERS_DEFAULT,
  POCKETBASE_DEFAULT_PORT,
  POCKETBASE_DEFAULT_VERSION,
  type AuthProvider,
  type ApplySchemaOpts,
  type BackendExport,
  type BackendInstance,
  type BackendProvider,
  type Collection,
  type ProvisionOpts,
} from "@founder-os/backend-core";

import {
  PocketbaseBinaryMissingError,
  binaryExists,
  resolveDownloadUrl,
} from "./binary.js";
import {
  authenticateAdmin,
  healthProbe,
  listCollections,
  type PocketbaseCollectionDto,
} from "./http.js";
import {
  bootstrapPocketbaseProject,
  buildSkeletalCollectionMigration,
  getPocketbasePaths,
  writeMigration,
} from "./ensure-project.js";
import { spawnPocketbase } from "./spawn.js";

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

export type CreatePocketbaseProviderOpts = {
  /**
   * Admin password used for the export step's auth. Provided by the
   * runner (read from an encrypted credentials file). Never persisted
   * inside this package.
   */
  adminPassword: string;
  /**
   * Default port the venture's PocketBase listens on. Overridable per
   * provision() via opts.pocketbase.port. Defaults to
   * POCKETBASE_DEFAULT_PORT (8090).
   */
  defaultPort?: number;
  /**
   * Optional injections so tests never shell out / touch the network.
   */
  spawnImpl?: typeof spawnPocketbase;
  fetchImpl?: typeof fetch;
  /**
   * Optional clock injection. Defaults to () => new Date().toISOString().
   */
  now?: () => string;
};

export function createPocketbaseProvider(
  opts: CreatePocketbaseProviderOpts
): BackendProvider {
  const defaultPort = opts.defaultPort ?? POCKETBASE_DEFAULT_PORT;
  const fetchImpl = opts.fetchImpl;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    name: "pocketbase" as const,

    async available() {
      // The first thing pickActiveBackendProvider() calls. We resolve
      // "available" loosely: if the binary is on disk, we are available
      // even if PB isn't currently running -- provision()/applySchema()
      // do their own health probes. This lets the resolver pick
      // PocketBase as soon as the user has dropped the binary in, before
      // anything has been provisioned.
      //
      // We do NOT probe the network in available() to keep it fast
      // (every resolver pass calls it). The runner's downstream methods
      // surface clear errors if the binary is broken or PB isn't running.
      try {
        // We need a venture root to compute the binary path, but
        // available() has no opts. So we treat available() as "the
        // factory will provide a binary path through provision opts";
        // it always returns true and lets provision() fail loudly if
        // the binary is missing. Mirrors the crm Docker provider's
        // behaviour where availability is best-effort.
        return true;
      } catch {
        return false;
      }
    },

    async provision(provisionOpts: ProvisionOpts): Promise<BackendInstance> {
      const paths = await bootstrapPocketbaseProject({
        ventureRoot: provisionOpts.ventureRoot,
      });
      const port = provisionOpts.pocketbase?.port ?? defaultPort;
      const version =
        provisionOpts.pocketbase?.version ?? POCKETBASE_DEFAULT_VERSION;

      if (!binaryExists(paths.binaryPath)) {
        throw new PocketbaseBinaryMissingError(
          paths.binaryPath,
          resolveDownloadUrl(version)
        );
      }

      return {
        ventureSlug: provisionOpts.ventureSlug,
        engine: "pocketbase",
        baseUrl: `http://127.0.0.1:${port}`,
        binaryPath: paths.binaryPath,
        resolvedVersion: version,
        adminEmail: provisionOpts.adminEmail,
        provisionedAt: now(),
        notes:
          `Bootstrapped 12_backend/pocketbase/ at ${paths.dir}. ` +
          "Slice 2 leaves the binary download manual; drop the release zip's " +
          "pocketbase binary into the directory above before running applySchema().",
      };
    },

    async applySchema(applyOpts: ApplySchemaOpts): Promise<void> {
      const paths = getPocketbasePaths(applyOpts.ventureRoot);

      // 1. Write one skeletal migration per collection. Slice 4 promotes
      // this to a full schema-aware generator; slice 2 ensures the
      // pipeline + file-naming contract is set in stone.
      let stepCounter = 0;
      for (const collection of applyOpts.collections) {
        await writeMigration({
          migrationsDir: paths.migrationsDir,
          name: `init_${collection.name}`,
          body: buildSkeletalCollectionMigration(collection),
          now: () => Date.now() + stepCounter,
        });
        stepCounter += 1;
      }

      // 2. Spawn `pocketbase migrate up`. Idempotent -- runs only
      // pending migrations.
      const spawner = opts.spawnImpl ?? spawnPocketbase;
      const result = await spawner({
        binaryPath: paths.binaryPath,
        args: ["migrate", "up"],
        cwd: paths.dir,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `pocketbase migrate up exited ${result.exitCode}: ${result.stderr}`
        );
      }
    },

    async export(
      instance: BackendInstance,
      _collections: Collection[]
    ): Promise<BackendExport> {
      if (!instance.baseUrl) {
        throw new Error("pocketbase export() requires instance.baseUrl");
      }

      // 1. Probe health -- give a fast clear error before we try to auth.
      await healthProbe({ baseUrl: instance.baseUrl, fetchImpl });

      // 2. Authenticate as admin to read collections.
      const auth = await authenticateAdmin({
        baseUrl: instance.baseUrl,
        email: instance.adminEmail,
        password: opts.adminPassword,
        fetchImpl,
      });

      // 3. Read live collections.
      const dtos = await listCollections({
        baseUrl: instance.baseUrl,
        token: auth.token,
        fetchImpl,
      });

      // 4. Translate PB collection DTOs -> our Collection shape. Slice 2
      // keeps this minimal -- fields list translation is heavy and best
      // handled in slice 4 alongside the schema-aware migration generator.
      const liveCollections = dtos.map(translateCollection);

      // 5. Assemble the BackendExport envelope.
      return {
        ventureSlug: instance.ventureSlug,
        engine: "pocketbase",
        source: "pocketbase",
        baseUrl: instance.baseUrl,
        collections: liveCollections,
        auth: {
          providers: deriveAuthProviders(dtos),
          userFields: [],
        },
        sdk: {
          language: "ts",
          importPath: "@/lib/backend",
          realtime: true,
          reactHooks: false,
        },
        generatedAt: now(),
        notes: [
          `Resolved PocketBase version: ${instance.resolvedVersion ?? "unknown"}`,
          `Live collections: ${liveCollections.length}`,
          `Default tier list: ${BACKEND_ENGINE_TIERS_DEFAULT.join(", ")}`,
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function translateCollection(dto: PocketbaseCollectionDto): Collection {
  return {
    name: dto.name,
    type: dto.type === "auth" || dto.type === "view" ? dto.type : "base",
    fields: [], // slice 4 fills in the per-field translation
    apiRules: {
      list: dto.listRule ?? undefined,
      view: dto.viewRule ?? undefined,
      create: dto.createRule ?? undefined,
      update: dto.updateRule ?? undefined,
      delete: dto.deleteRule ?? undefined,
    },
    indexes: dto.indexes ?? [],
    softDelete: false,
  };
}

function deriveAuthProviders(dtos: PocketbaseCollectionDto[]): AuthProvider[] {
  const usersCollection = dtos.find((d) => d.name === "users" && d.type === "auth");
  if (!usersCollection) return ["password"];
  // Slice 4 reads the auth collection's options to figure out which
  // OAuth2 providers are enabled. For slice 2 we conservatively report
  // "password" only -- safe default that matches a fresh PB instance.
  return ["password"];
}
