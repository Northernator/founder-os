/**
 * createCrmProvisionStep -- slice 4 of CRM arc.
 *
 * Walks the configured tier list (Docker / bench / config-only) and
 * picks the first available CrmProvider, then writes the resulting
 * CrmInstance to 11_crm/crm-instance.json. Slice 7 wires the real
 * Docker bootstrap orchestrator; until then, provisioning a fresh
 * Docker stack throws and the resolver falls through.
 *
 * Idempotent: re-running with the same providers reuses an existing
 * instance file if its engine still resolves available=true.
 *
 * Subscription-preferred LLM routing is NOT used here -- this step
 * doesn't call the LLM. The campaign-template step does.
 */
import {
  CRM_ENGINE_TIERS_DEFAULT,
  type CrmEngine,
  type CrmInstance,
  type CrmProvider,
} from "@founder-os/crm-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  getCrmConfigPath,
  getCrmDir,
  getCrmInstancePath,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";

export type CreateCrmProvisionContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  /**
   * Providers the runner can dispatch to. The desktop app constructs
   * these via the Tauri sidecar (createConfigOnlyProvider always; the
   * Frappe ones if probes report available). Empty providers map means
   * the resolver will simply not pick anything (and the step throws).
   */
  providers: Partial<Record<CrmEngine, CrmProvider>>;
  /**
   * Override the tier list (per-venture preference). Defaults to
   * manifest.crm.engineTiers, then CRM_ENGINE_TIERS_DEFAULT.
   */
  tierList?: ReadonlyArray<CrmEngine>;
  runId?: string;
  now?: () => Date;
};

export type CreateCrmProvisionResult = {
  status: "done";
  /**
   * The picked provider's CrmInstance. The runner echoes this into
   * 11_crm/crm-instance.json.
   */
  instance: CrmInstance;
  /**
   * Which engine the resolver picked. Mirrors `instance.engine`.
   */
  engine: CrmEngine;
  /**
   * The picked provider, returned so the seed + campaign steps can
   * reuse it without re-resolving.
   */
  provider: CrmProvider;
  /**
   * Disk path of crm-instance.json.
   */
  instancePath: string;
  /**
   * Tier-by-tier probe results. Useful for log-strings + UI rendering.
   */
  attempts: ReadonlyArray<{ engine: CrmEngine; available: boolean }>;
};

export class CrmProvisionResolverError extends Error {
  override readonly name = "CrmProvisionResolverError";
  constructor(readonly attempts: ReadonlyArray<{ engine: CrmEngine; available: boolean }>) {
    super(
      `No CRM provider was available. Tried: ${attempts
        .map((a) => `${a.engine}=${a.available ? "ok" : "skip"}`)
        .join(", ")}`,
    );
  }
}

export async function createCrmProvisionStep(
  ctx: CreateCrmProvisionContext,
): Promise<CreateCrmProvisionResult> {
  const now = ctx.now ?? (() => new Date());
  const tierList =
    ctx.tierList ??
    ctx.manifest.crm?.engineTiers ??
    [...CRM_ENGINE_TIERS_DEFAULT];

  const attempts: Array<{ engine: CrmEngine; available: boolean }> = [];
  let picked: CrmProvider | null = null;
  let pickedEngine: CrmEngine | null = null;

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
    throw new CrmProvisionResolverError(attempts);
  }

  const adminEmail = ctx.manifest.crm?.adminEmail ?? "founder@example.com";

  const instance = await picked.provision({
    ventureSlug: ctx.manifest.slug,
    adminEmail,
    docker: ctx.manifest.crm?.docker,
    bench: ctx.manifest.crm?.bench,
  });

  // Force the timestamp to our clock for determinism, even though most
  // providers already set it correctly via Date.now -- belt and braces.
  if (ctx.now) {
    instance.provisionedAt = now().toISOString();
  }

  await ctx.fs.mkdir(getCrmDir(ctx.ventureRoot));
  const instancePath = getCrmInstancePath(ctx.ventureRoot);
  await ctx.fs.writeFile(
    instancePath,
    `${JSON.stringify(instance, null, 2)}\n`,
  );

  // crm-config.json is a small public-facing record of the resolved
  // engine + non-secret config knobs. Useful for the gate UI before the
  // first run completes (e.g. "Active engine: Docker · localhost:8000").
  // Never contains the API key itself.
  await ctx.fs.writeFile(
    getCrmConfigPath(ctx.ventureRoot),
    `${JSON.stringify(
      {
        engine: pickedEngine,
        siteUrl: instance.siteUrl,
        adminEmail,
        provisionedAt: instance.provisionedAt,
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
    attempts,
  };
}
