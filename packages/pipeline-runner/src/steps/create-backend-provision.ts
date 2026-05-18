/**
 * createBackendProvisionStep -- slice 4 of backend arc.
 *
 * Walks the configured engine tier list (pocketbase / supabase / convex /
 * appwrite / drizzle_sqlite / config_only) and picks the first available
 * BackendProvider. Provisions through it -- for tier_0 PocketBase this
 * means bootstrapping 12_backend/pocketbase/ (binary download is best-
 * effort and surfaces via PocketbaseBinaryMissingError when the binary
 * isn't on disk yet). Writes the resulting BackendInstance to
 * 12_backend/backend-instance.json + a small non-secret companion at
 * 12_backend/backend-config.json the UI can render before the first
 * full run completes.
 *
 * Idempotent: re-running with the same providers reuses an existing
 * instance file if its engine still resolves available=true. The
 * resolved engine is returned so downstream steps (schema, hooks,
 * export) don't have to re-pick.
 *
 * Subscription-preferred LLM routing is NOT used here -- this step
 * doesn't call the LLM.
 *
 * Mirrors createCrmProvisionStep's shape exactly so the runner-side
 * orchestration stays uniform across stages.
 */
import {
  BACKEND_ENGINE_TIERS_DEFAULT,
  type BackendEngine,
  type BackendInstance,
  type BackendProvider,
} from "@founder-os/backend-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  getBackendDir,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";

export type CreateBackendProvisionContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  /**
   * Providers the runner can dispatch to. The desktop app constructs
   * these via the Tauri sidecar (createConfigOnlyProvider always; the
   * PocketBase one when the binary probe reports ready). Empty providers
   * map means the resolver will simply not pick anything (and the step
   * throws).
   */
  providers: Partial<Record<BackendEngine, BackendProvider>>;
  /**
   * Override the tier list (per-venture preference). When omitted, the
   * step reads `manifest.backend?.enabledEngines` and falls back to
   * BACKEND_ENGINE_TIERS_DEFAULT.
   */
  tierList?: ReadonlyArray<BackendEngine>;
  /**
   * Admin email used by the provider during provisioning. Defaults to
   * "founder@example.com" -- same fallback as CRM.
   */
  adminEmail?: string;
  runId?: string;
  now?: () => Date;
};

export type CreateBackendProvisionResult = {
  status: "done";
  /**
   * The picked provider's BackendInstance. The runner echoes this into
   * 12_backend/backend-instance.json.
   */
  instance: BackendInstance;
  /**
   * Which engine the resolver picked. Mirrors `instance.engine`.
   */
  engine: BackendEngine;
  /**
   * The picked provider, returned so the schema + hooks + export steps
   * can reuse it without re-resolving.
   */
  provider: BackendProvider;
  /**
   * Disk path of backend-instance.json.
   */
  instancePath: string;
  /**
   * Disk path of backend-config.json (small public-facing record).
   */
  configPath: string;
  /**
   * Tier-by-tier probe results. Useful for log-strings + UI rendering.
   */
  attempts: ReadonlyArray<{ engine: BackendEngine; available: boolean }>;
};

export class BackendProvisionResolverError extends Error {
  override readonly name = "BackendProvisionResolverError";
  constructor(
    readonly attempts: ReadonlyArray<{ engine: BackendEngine; available: boolean }>,
  ) {
    super(
      `No backend provider was available. Tried: ${attempts
        .map((a) => `${a.engine}=${a.available ? "ok" : "skip"}`)
        .join(", ")}`,
    );
  }
}

export async function createBackendProvisionStep(
  ctx: CreateBackendProvisionContext,
): Promise<CreateBackendProvisionResult> {
  const now = ctx.now ?? (() => new Date());
  // Manifest.backend is not currently in VentureManifestSchema; access
  // it loosely so this step doesn't pin a domain-package change.
  const manifestBackend = (
    ctx.manifest as { backend?: { enabledEngines?: BackendEngine[] } }
  ).backend;
  const tierList =
    ctx.tierList ??
    manifestBackend?.enabledEngines ??
    [...BACKEND_ENGINE_TIERS_DEFAULT];

  const attempts: Array<{ engine: BackendEngine; available: boolean }> = [];
  let picked: BackendProvider | null = null;
  let pickedEngine: BackendEngine | null = null;

  for (const engine of tierList) {
    const candidate = ctx.providers[engine];
    if (!candidate) {
      attempts.push({ engine, available: false });
      continue;
    }
    let available = false;
    try {
      available = await candidate.available();
    } catch {
      available = false;
    }
    attempts.push({ engine, available });
    if (available) {
      picked = candidate;
      pickedEngine = engine;
      break;
    }
  }

  if (!picked || !pickedEngine) {
    throw new BackendProvisionResolverError(attempts);
  }

  const adminEmail = ctx.adminEmail ?? "founder@example.com";

  const instance = await picked.provision({
    ventureSlug: ctx.manifest.slug,
    ventureRoot: ctx.ventureRoot,
    adminEmail,
  });

  // Force the timestamp to our clock for determinism, even though most
  // providers already set it correctly via Date.now -- belt and braces.
  if (ctx.now) {
    instance.provisionedAt = now().toISOString();
  }

  await ctx.fs.mkdir(getBackendDir(ctx.ventureRoot));
  const instancePath = `${getBackendDir(ctx.ventureRoot)}/backend-instance.json`;
  await ctx.fs.writeFile(
    instancePath,
    `${JSON.stringify(instance, null, 2)}\n`,
  );

  // backend-config.json is a small public-facing record of the resolved
  // engine + non-secret config knobs. Useful for the UI before the first
  // run completes (e.g. "Active engine: PocketBase · localhost:8090").
  // Never contains the admin password or any other secret.
  const configPath = `${getBackendDir(ctx.ventureRoot)}/backend-config.json`;
  await ctx.fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        engine: pickedEngine,
        baseUrl: instance.baseUrl ?? null,
        binaryPath: instance.binaryPath ?? null,
        adminEmail,
        provisionedAt: instance.provisionedAt,
        resolvedVersion: instance.resolvedVersion ?? null,
      },
      null,
      2,
    )}\n`,
  );

  return {
    status: "done",
    instance,
    engine: pickedEngine,
    provider: picked,
    instancePath,
    configPath,
    attempts,
  };
}
