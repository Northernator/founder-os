/**
 * Appwrite provider -- TIER_3 STUB. Slice 2 of the backend arc.
 *
 * Appwrite is the open-source self-hostable BaaS. Broader feature surface than PocketBase (functions, messaging) but heavier -- deployment is a Docker stack, not a single binary. Tier_3 because most ventures won't outgrow PocketBase before they hit Postgres-scale problems.
 *
 * SLICE 2 IS A STUB. `available()` returns false and `provision()` /
 * `applySchema()` / `export()` throw AppwriteNotImplementedError with a
 * helpful pointer at what slice 7+ would need to wire up. The factory +
 * options shape is locked so future implementors only touch the
 * internals of the methods, not the public surface.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  *  - Spawn `appwrite login` + `appwrite init` to bind the
 *    repo to an Appwrite instance (cloud or self-hosted).
 *  - On applySchema(): translate Collection -> Appwrite
 *    Database/Collection API calls via node-appwrite.
 *  - On export(): list collections via the same SDK and
 *    assemble engine='appwrite'.
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

export interface AppwriteProviderOpts {
  /**
   * Appwrite endpoint (cloud URL or self-hosted).
   */
  endpoint?: string;
  /**
   * Appwrite project ID.
   */
  projectId?: string;
  /**
   * Server API key. Read from encrypted credentials.
   */
  apiKey?: string;
}

export class AppwriteNotImplementedError extends Error {
  override readonly name = "AppwriteNotImplementedError";
  constructor(method: string) {
    super(
      `Appwrite.${method}() is a stub. Slice 7+ ships the real implementation; ` +
        "until then this engine is skipped by the resolver via available()=false."
    );
  }
}

export function createAppwriteProvider(_opts: AppwriteProviderOpts = {}): BackendProvider {
  return {
    name: "appwrite" as const,

    async available() {
      return false;
    },

    async provision(_provisionOpts: ProvisionOpts): Promise<BackendInstance> {
      throw new AppwriteNotImplementedError("provision");
    },

    async applySchema(_applyOpts: ApplySchemaOpts): Promise<void> {
      throw new AppwriteNotImplementedError("applySchema");
    },

    async export(
      _instance: BackendInstance,
      _collections: Collection[]
    ): Promise<BackendExport> {
      throw new AppwriteNotImplementedError("export");
    },
  };
}
