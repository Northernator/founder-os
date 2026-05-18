/**
 * Config-only BackendProvider.
 *
 * The always-available fallback. Makes ZERO HTTP calls and spawns ZERO
 * subprocesses. provision() returns a BackendInstance with no baseUrl /
 * no binaryPath; applySchema() captures the collections in memory;
 * export() emits a BackendExport with engine='config_only' and an SDK
 * stub pointing at "@/lib/backend".
 *
 * This is the "skip path" from spec sec 6 -- ventures that don't need
 * a backend (marketing sites, pure-frontend extensions) still get a
 * valid BackendExport so the BUILD stage's contract reader doesn't have
 * to branch.
 *
 * Mirrors the @founder-os/crm-providers config-only-provider shape but
 * adapted to the BackendProvider surface (collections instead of
 * segments + contacts + opportunities).
 */

import type {
  ApplySchemaOpts,
  BackendExport,
  BackendInstance,
  BackendProvider,
  Collection,
  ProvisionOpts,
} from "@founder-os/backend-core";

export type ConfigOnlyProviderOpts = {
  /**
   * Optional clock injection for tests so the provisionedAt + generatedAt
   * timestamps are deterministic. Defaults to () => new Date().toISOString().
   */
  now?: () => string;
};

export function createConfigOnlyProvider(
  opts: ConfigOnlyProviderOpts = {}
): BackendProvider & {
  /**
   * Snapshot of every collection that's been passed through applySchema().
   * Useful for the runner's checkpoint writer.
   */
  snapshot(): { collections: Collection[] };
} {
  const now = opts.now ?? (() => new Date().toISOString());
  const captured: Collection[] = [];

  return {
    name: "config_only" as const,

    async available() {
      return true;
    },

    async provision(input: ProvisionOpts): Promise<BackendInstance> {
      return {
        ventureSlug: input.ventureSlug,
        engine: "config_only",
        baseUrl: undefined,
        binaryPath: undefined,
        resolvedVersion: undefined,
        adminEmail: input.adminEmail,
        provisionedAt: now(),
        notes:
          "config_only -- no backend was provisioned. JSON export still emitted " +
          "for BUILD to read, with sdk stubs pointing at @/lib/backend.",
      };
    },

    async applySchema(input: ApplySchemaOpts): Promise<void> {
      captured.push(...input.collections);
    },

    async export(
      instance: BackendInstance,
      collections: Collection[]
    ): Promise<BackendExport> {
      const merged = collections.length > 0 ? collections : captured;
      return {
        ventureSlug: instance.ventureSlug,
        engine: "config_only",
        source: "config_only",
        // config_only ventures still need a URL placeholder for the
        // BackendExport zod schema. Use about:blank so BUILD can detect
        // "no live backend" and emit stubs instead of real fetch calls.
        baseUrl: "http://localhost",
        collections: merged,
        auth: { providers: ["password"], userFields: [] },
        sdk: {
          language: "ts",
          importPath: "@/lib/backend",
          realtime: false,
          reactHooks: false,
        },
        generatedAt: now(),
        notes: [
          "engine=config_only -- no backend provisioned",
          `Captured collections: ${merged.length}`,
        ],
      };
    },

    snapshot() {
      return { collections: [...captured] };
    },
  };
}
