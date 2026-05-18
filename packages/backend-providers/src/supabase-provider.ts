/**
 * Supabase BackendProvider -- TIER_1.
 *
 * Slice 3 of the Supabase arc replaces the slice-2 stub with the real
 * implementation. BYOP credentials flow (the founder creates the
 * Supabase project themselves and pastes projectUrl + service-role key
 * into the BackendTab; the provider never creates infrastructure). See
 * bizBuild/SUPABASE-MODULE-SPEC.md for the design.
 *
 * Method semantics:
 *
 *   - available()    Resolves credentials from the supplied env
 *                    snapshot. No network. Fast -- safe to call from
 *                    every resolver pass.
 *
 *   - provision()    Validates credentials against
 *                    <projectUrl>/auth/v1/health. Returns a
 *                    BackendInstance pointing at the existing project.
 *                    BYOP: never creates anything on supabase.com.
 *
 *   - applySchema()  Checks the `public.exec_sql` helper is installed
 *                    (surfaces MissingExecSqlError with the bootstrap
 *                    SQL if not), then walks the buildApplySchemaPlan
 *                    output, executing each statement via exec_sql.
 *
 *   - export()       Re-validates credentials, calls /auth/v1/settings
 *                    to learn which providers are enabled, assembles
 *                    BackendExport with source: "supabase".
 *
 * Stays Node-stdlib-free: no `node:*` imports anywhere in this file or
 * its helpers. Safe to ship from the client-safe barrel for the
 * capability-metadata side, even though in practice the WebView reaches
 * the provider via Tauri commands (slice 7).
 */

import {
  BACKEND_ENGINE_TIERS_DEFAULT,
  resolveSupabaseCredentials,
  type ApplySchemaOpts,
  type AuthProvider,
  type BackendExport,
  type BackendInstance,
  type BackendProvider,
  type Collection,
  type ProvisionOpts,
  type SupabaseConfig,
  type SupabaseCredentials,
} from "@founder-os/backend-core";

import { buildApplySchemaPlan } from "./supabase-ddl.js";
import {
  EXEC_SQL_BOOTSTRAP_SQL,
  MissingExecSqlError,
  SupabaseBadCredentialsError,
  SupabaseHealthError,
  SupabaseHttpError,
  checkExecSqlExists,
  execSql,
  healthProbe,
  type FetchLike,
} from "./supabase-http.js";

// Re-export the error classes + bootstrap SQL so the BackendTab + the
// schema-step review gate can import them through the same barrel as
// the factory.
export {
  EXEC_SQL_BOOTSTRAP_SQL,
  MissingExecSqlError,
  SupabaseBadCredentialsError,
  SupabaseHealthError,
  SupabaseHttpError,
};

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

export type CreateSupabaseProviderOpts = {
  config: SupabaseConfig;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => string;
};

export type SupabaseProviderOpts = CreateSupabaseProviderOpts;

export function createSupabaseProvider(
  opts: CreateSupabaseProviderOpts
): BackendProvider {
  const now = opts.now ?? (() => new Date().toISOString());
  const fetchImpl = opts.fetchImpl;

  function resolveCreds(): SupabaseCredentials {
    const r = resolveSupabaseCredentials(opts.config, opts.env);
    if ("error" in r) {
      throw new SupabaseBadCredentialsError(
        401,
        `Credentials missing: ${r.which}${r.envVarName ? ` (env var ${r.envVarName})` : ""}`
      );
    }
    return r;
  }

  return {
    name: "supabase" as const,

    async available(): Promise<boolean> {
      const r = resolveSupabaseCredentials(opts.config, opts.env);
      return !("error" in r);
    },

    async provision(provisionOpts: ProvisionOpts): Promise<BackendInstance> {
      const creds = resolveCreds();
      const health = await healthProbe({
        projectUrl: creds.projectUrl,
        fetchImpl,
      });
      return {
        ventureSlug: provisionOpts.ventureSlug,
        engine: "supabase",
        baseUrl: creds.projectUrl,
        resolvedVersion: health.version || "supabase-unknown",
        adminEmail: provisionOpts.adminEmail,
        provisionedAt: now(),
        notes:
          `BYOP mode: validated existing Supabase project at ${creds.projectUrl}. ` +
          "No infrastructure was created. applySchema() will run DDL via the " +
          "service-role key (paste exec_sql bootstrap SQL into your project's SQL " +
          "editor once if you haven't already).",
      };
    },

    async applySchema(applyOpts: ApplySchemaOpts): Promise<void> {
      const creds = resolveCreds();

      const ok = await checkExecSqlExists({
        projectUrl: creds.projectUrl,
        serviceRoleKey: creds.serviceRoleKey,
        fetchImpl,
      });
      if (!ok) {
        throw new MissingExecSqlError(EXEC_SQL_BOOTSTRAP_SQL);
      }

      const plan = buildApplySchemaPlan(applyOpts.collections);
      for (const sql of plan.statements) {
        await execSql({
          projectUrl: creds.projectUrl,
          serviceRoleKey: creds.serviceRoleKey,
          sql,
          fetchImpl,
        });
      }
    },

    async export(
      instance: BackendInstance,
      collections: Collection[]
    ): Promise<BackendExport> {
      const creds = resolveCreds();
      const baseUrl = instance.baseUrl ?? creds.projectUrl;

      await healthProbe({ projectUrl: baseUrl, fetchImpl });

      const providers = await readEnabledAuthProviders({
        projectUrl: baseUrl,
        fetchImpl,
      });

      return {
        ventureSlug: instance.ventureSlug,
        engine: "supabase",
        source: "supabase",
        baseUrl,
        collections,
        auth: {
          providers,
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
          `Supabase project URL: ${baseUrl}`,
          `gotrue version (from health probe): ${instance.resolvedVersion ?? "unknown"}`,
          `Applied ${collections.length} collection(s).`,
          `Default tier list: ${BACKEND_ENGINE_TIERS_DEFAULT.join(", ")}`,
          "Credentials are read from env at runtime; no service-role key was persisted by this provider.",
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Auth-provider introspection -- best-effort
// ---------------------------------------------------------------------------

type GoTrueSettingsResponse = {
  external?: Record<string, unknown>;
};

const GOTRUE_TO_AUTH_PROVIDER: Record<string, AuthProvider> = {
  google: "google",
  github: "github",
  apple: "apple",
  discord: "discord",
};

async function readEnabledAuthProviders(opts: {
  projectUrl: string;
  fetchImpl?: FetchLike;
}): Promise<AuthProvider[]> {
  const fetcher = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetcher) return ["password"];
  const url = `${opts.projectUrl.replace(/\/+$/, "")}/auth/v1/settings`;
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET" });
  } catch {
    return ["password"];
  }
  if (!response.ok) return ["password"];
  let body: GoTrueSettingsResponse;
  try {
    body = (await response.json()) as GoTrueSettingsResponse;
  } catch {
    return ["password"];
  }
  const providers: AuthProvider[] = ["password"];
  const external = body.external ?? {};
  for (const [key, value] of Object.entries(external)) {
    const mapped = GOTRUE_TO_AUTH_PROVIDER[key];
    if (!mapped) continue;
    if (
      typeof value === "object" &&
      value !== null &&
      "enabled" in value &&
      (value as { enabled?: unknown }).enabled === true
    ) {
      providers.push(mapped);
    } else if (value === true) {
      providers.push(mapped);
    }
  }
  return Array.from(new Set(providers));
}
