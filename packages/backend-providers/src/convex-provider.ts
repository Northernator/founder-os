/**
 * Convex provider -- TIER_2 STUB. Slice 2 of the backend arc.
 *
 * Convex is the TypeScript-native hosted tier. Functions live in convex/ next to the frontend; types flow end-to-end. Best DX of any backend in this list, but the venture is tied to Convex's runtime and less SQL-flexible than Supabase.
 *
 * SLICE 2 IS A STUB. `available()` returns false and `provision()` /
 * `applySchema()` / `export()` throw ConvexNotImplementedError with a
 * helpful pointer at what slice 7+ would need to wire up. The factory +
 * options shape is locked so future implementors only touch the
 * internals of the methods, not the public surface.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  *  - Spawn `npx convex dev --once --configure=existing` to
 *    bind the venture's repo to a Convex deployment.
 *  - On applySchema(): translate Collection -> Convex schema.ts
 *    + write under 12_backend/convex/schema.ts; the Convex
 *    deploy CLI handles the actual remote migration.
 *  - On export(): read the deployment URL + auth provider list
 *    via the Convex CLI and assemble engine='convex'.
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

export interface ConvexProviderOpts {
  /**
   * Convex deployment URL (https://<name>.convex.cloud).
   */
  deploymentUrl?: string;
  /**
   * CONVEX_DEPLOY_KEY. Read from encrypted credentials.
   */
  deployKey?: string;
}

export class ConvexNotImplementedError extends Error {
  override readonly name = "ConvexNotImplementedError";
  constructor(method: string) {
    super(
      `Convex.${method}() is a stub. Slice 7+ ships the real implementation; ` +
        "until then this engine is skipped by the resolver via available()=false."
    );
  }
}

export function createConvexProvider(_opts: ConvexProviderOpts = {}): BackendProvider {
  return {
    name: "convex" as const,

    async available() {
      return false;
    },

    async provision(_provisionOpts: ProvisionOpts): Promise<BackendInstance> {
      throw new ConvexNotImplementedError("provision");
    },

    async applySchema(_applyOpts: ApplySchemaOpts): Promise<void> {
      throw new ConvexNotImplementedError("applySchema");
    },

    async export(
      _instance: BackendInstance,
      _collections: Collection[]
    ): Promise<BackendExport> {
      throw new ConvexNotImplementedError("export");
    },
  };
}
