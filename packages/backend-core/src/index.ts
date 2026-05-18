// @founder-os/backend-core -- contract for the BACKEND_READY pipeline stage.
//
// Slice 1: types + zod schemas + parse helpers + defaults only.
// No provider implementations, no subprocess code, no HTTP -- those live
// in @founder-os/backend-providers (slice 2). See
// bizBuild/POCKETBASE-MODULE-SPEC.md for the design.
//
// Local-first by default: tier_0 PocketBase ships as a single binary that
// the provider downloads into the venture's 12_backend/pocketbase/ dir.
// Hosted tiers (Supabase / Convex / Appwrite Cloud) are opt-in per
// venture, finance-capped via FINANCE.backendHostingMonthlyUsdCap.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Engines + tier ordering
// ---------------------------------------------------------------------------

/**
 * Backend engines the pipeline knows how to dispatch to. Tier_0 is
 * PocketBase (single binary, embedded SQLite, free, local-first); tiers
 * 1-5 are stubs in slice 2 with available()=false so the resolver never
 * picks them until they have real implementations.
 */
export const BackendEngineSchema = z.enum([
  "pocketbase",     // tier_0 -- single binary, embedded SQLite, free, local-first
  "supabase",       // tier_1 -- hosted Postgres + auth + realtime, free tier
  "convex",         // tier_2 -- TS-native, hosted, free tier
  "appwrite",       // tier_3 -- open-source, self-host or cloud
  "drizzle_sqlite", // tier_4 -- DIY, Drizzle ORM + SQLite, embeddable
  "config_only",    // tier_5 -- emit schema only, user wires backend later
]);
export type BackendEngine = z.infer<typeof BackendEngineSchema>;

/**
 * Default tier order for new ventures. supabase / convex / appwrite are
 * intentionally absent -- opt-in per venture, mirroring how gemini_api is
 * absent from PROVIDER_TIERS_DEFAULT in @founder-os/media-core. Override
 * per venture in venture.yaml under backend.enabledEngines.
 */
export const BACKEND_ENGINE_TIERS_DEFAULT: ReadonlyArray<BackendEngine> = [
  "pocketbase",
  "drizzle_sqlite",
  "config_only",
];

// ---------------------------------------------------------------------------
// Hosting cost estimates -- the FINANCE tie-in (slice 7)
// ---------------------------------------------------------------------------

/**
 * Best-effort monthly hosting USD per engine. Used by the FINANCE plan to
 * surface the resolved engine's expected hosting cost and by the advance-
 * gate audit rule to refuse LAUNCH when the resolved engine's cost
 * exceeds `finance-canvas.backendHostingMonthlyUsdCap`.
 *
 * Numbers are deliberately conservative free-tier / self-host baselines:
 *   - pocketbase / drizzle_sqlite / config_only: $0 (single binary or
 *     local SQLite, no hosting fee). A founder who Fly.io / Railway-hosts
 *     a PocketBase binary pays ~$5/month but the pipeline doesn't pick
 *     that for them.
 *   - supabase / convex: $0 on free tier, with paid plans starting at
 *     $25/month (Supabase) / $25/month (Convex Pro). We surface $25 to
 *     give the founder a realistic "what happens when I outgrow the free
 *     tier" anchor rather than the marketing $0.
 *   - appwrite: free if self-hosted; Cloud starts at $15/month. We pick
 *     $15 as the conservative case because most founders pick Cloud, not
 *     the self-host Docker stack.
 *
 * Surface this as an ESTIMATE, not a quote. The advance-gate rule fires
 * when estimate > cap; the founder can override per-venture by raising
 * the cap in the FinanceTab.
 */
export const BACKEND_ENGINE_MONTHLY_USD_ESTIMATE: Record<BackendEngine, number> = {
  pocketbase: 0,
  supabase: 25,
  convex: 25,
  appwrite: 15,
  drizzle_sqlite: 0,
  config_only: 0,
};

/**
 * Resolve the monthly USD estimate for a given engine, defaulting to 0
 * for unknown engines (shouldn't happen -- the enum is exhaustive -- but
 * defensive against future engine additions that forget to extend the
 * cost map). Mirrors the conservative "fire findings when in doubt"
 * stance used elsewhere (see audit-venture.shouldFireAtStage).
 */
export function estimatedMonthlyHostingUsd(engine: BackendEngine): number {
  return BACKEND_ENGINE_MONTHLY_USD_ESTIMATE[engine] ?? 0;
}

// ---------------------------------------------------------------------------
// PocketBase defaults
// ---------------------------------------------------------------------------

/**
 * Pinned PocketBase minor. Slice 2 may swap this for a specific patch
 * version once the binary-download path is verified across platforms.
 */
export const POCKETBASE_DEFAULT_VERSION = "0.22.x";

/**
 * Default HTTP port the venture's PocketBase binary listens on. Two
 * ventures running on the same machine should override per-venture in
 * venture.yaml under backend.pocketbase.port to avoid collisions.
 */
export const POCKETBASE_DEFAULT_PORT = 8090;

/**
 * Default binary-download base. The provider appends the platform tuple
 * and version to derive the actual release asset URL.
 */
export const POCKETBASE_DOWNLOAD_BASE =
  "https://github.com/pocketbase/pocketbase/releases/download";

// ---------------------------------------------------------------------------
// Field + Collection schemas (the PocketBase shape, but engine-agnostic)
// ---------------------------------------------------------------------------

/**
 * Per spec sec 8: how PRODUCT_SPEC field types map onto provider-native
 * field kinds. The Schema-derivation step in pipeline-runner translates
 * a PRODUCT_SPEC entity into this shape, then the provider translates
 * THIS shape into its native migrations / DDL / collection definitions.
 *
 * The kind list is the LCD across all five engines -- everything here
 * has a clean mapping in PocketBase, Postgres (Supabase), and Drizzle.
 */
export const FieldKindSchema = z.enum([
  "text",     // <= 255 chars
  "longText", // up to 10000 chars
  "richText", // markdown / rich-text editor field
  "email",
  "url",
  "number",
  "bool",
  "date",     // ISO 8601
  "select",   // enum -- see options[]
  "json",
  "file",     // see maxFileSizeBytes + mimeTypes
  "relation", // see relatesTo + cascadeDelete
]);
export type FieldKind = z.infer<typeof FieldKindSchema>;

export const FieldSchema = z.object({
  name: z.string().min(1),
  kind: FieldKindSchema,
  required: z.boolean().default(false),
  unique: z.boolean().default(false),

  // kind === "relation"
  relatesTo: z.string().optional(),
  cascadeDelete: z.boolean().optional(),
  maxSelect: z.number().int().positive().optional(),

  // kind === "select"
  options: z.array(z.string()).optional(),

  // kind === "file"
  maxFileSizeBytes: z.number().int().positive().optional(),
  mimeTypes: z.array(z.string()).optional(),
});
export type Field = z.infer<typeof FieldSchema>;

/**
 * Conservative API rule defaults per spec sec 8. The schema step emits
 * these and flags them for review; the user can tighten or loosen at the
 * review gate before BUILD reads the export.
 *
 * PB filter DSL is used as-is in tier_0; tiers 1-4 translate to their
 * own RLS / rule grammar.
 */
export const ApiRulesSchema = z.object({
  list: z.string().optional(),
  view: z.string().optional(),
  create: z.string().optional(),
  update: z.string().optional(),
  delete: z.string().optional(),
});
export type ApiRules = z.infer<typeof ApiRulesSchema>;

export const CollectionTypeSchema = z.enum(["base", "auth", "view"]);
export type CollectionType = z.infer<typeof CollectionTypeSchema>;

export const CollectionSchema = z.object({
  name: z.string().min(1),          // singular, snake_case: "task", "user_profile"
  type: CollectionTypeSchema.default("base"),
  fields: z.array(FieldSchema),
  apiRules: ApiRulesSchema.default({}),
  indexes: z.array(z.string()).default([]),
  softDelete: z.boolean().default(false),
});
export type Collection = z.infer<typeof CollectionSchema>;

// ---------------------------------------------------------------------------
// Auth + SDK shape
// ---------------------------------------------------------------------------

export const AuthProviderSchema = z.enum([
  "password",
  "google",
  "github",
  "apple",
  "discord",
]);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const BackendAuthSchema = z.object({
  providers: z.array(AuthProviderSchema).default(["password"]),
  /**
   * Extra fields appended to the users (auth) collection on top of the
   * provider defaults. Conventionally name + avatar.
   */
  userFields: z.array(FieldSchema).default([]),
});
export type BackendAuth = z.infer<typeof BackendAuthSchema>;

export const BackendSdkSchema = z.object({
  language: z.literal("ts").default("ts"),
  /**
   * Import path the BUILD scaffold uses, e.g. "@/lib/backend". The SDK
   * files land under 12_backend/sdk/ and BUILD's tsconfig maps the alias.
   */
  importPath: z.string().default("@/lib/backend"),
  realtime: z.boolean().default(true),
  /**
   * Whether BUILD should emit React Query / SWR hooks per collection.
   * Gated on build.framework === "react" -- the scaffolder reads this
   * AND the framework signal before emitting hooks.ts.
   */
  reactHooks: z.boolean().default(false),
});
export type BackendSdk = z.infer<typeof BackendSdkSchema>;

// ---------------------------------------------------------------------------
// BackendExport -- the canonical artifact BUILD consumes
// ---------------------------------------------------------------------------

/**
 * Lives at 12_backend/backend-export.json. BUILD reads this in the same
 * shape regardless of which engine ran -- provider-agnostic, with
 * `source` discriminating downstream codegen. Mirrors HandoffExport
 * from @founder-os/handoff-contract.
 */
export const BackendExportSchema = z.object({
  ventureSlug: z.string(),
  engine: BackendEngineSchema,
  source: BackendEngineSchema,    // duplicate of engine -- kept for parity
                                  // with HandoffExport.source naming
  baseUrl: z.string().url(),
  collections: z.array(CollectionSchema),
  auth: BackendAuthSchema,
  sdk: BackendSdkSchema,
  generatedAt: z.string().datetime(),
  /**
   * Free-text notes the provider can append (e.g. binary version,
   * download size, deferred follow-ups). Surfaced in the runner's log
   * tail and in the desktop pill tooltip.
   */
  notes: z.array(z.string()).default([]),
});
export type BackendExport = z.infer<typeof BackendExportSchema>;

// ---------------------------------------------------------------------------
// Per-venture config (lives under VentureManifest.backend)
// ---------------------------------------------------------------------------

export const PocketbaseConfigSchema = z.object({
  version: z.string().default(POCKETBASE_DEFAULT_VERSION),
  port: z.number().int().min(1).max(65535).default(POCKETBASE_DEFAULT_PORT),
  /**
   * If true, the runner spawns PocketBase via Docker instead of native
   * binary. Off by default -- native is faster for dev.
   */
  deterministicDev: z.boolean().default(false),
});
export type PocketbaseConfig = z.infer<typeof PocketbaseConfigSchema>;

// ---------------------------------------------------------------------------
// Supabase per-venture config (slice 2 of the Supabase arc -- see
// bizBuild/SUPABASE-MODULE-SPEC.md sec 3 for the BYOP credentials flow)
// ---------------------------------------------------------------------------

/**
 * Default env var name for the Supabase anon key when the manifest
 * doesn't pick a venture-scoped name. The provider falls back to this
 * if `SupabaseConfig.anonKeyEnvVar` is left at its default.
 *
 * Conventionally the per-venture name is `SUPABASE_ANON_KEY_<SLUG_SNAKE>`
 * so two ventures on the same machine don't clash; the default below
 * is the global one, which is fine for the single-venture-per-shell
 * common case.
 */
export const SUPABASE_DEFAULT_ANON_KEY_ENV_VAR = "SUPABASE_ANON_KEY";

/**
 * Default env var name for the Supabase service-role key. SECRET --
 * never log it, never write to the WebView, never persist it under
 * `12_backend/` outside the gitignored `.credentials.json` mentioned
 * in the spec.
 */
export const SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR =
  "SUPABASE_SERVICE_ROLE_KEY";

/**
 * Per-venture Supabase config. Lives under `manifest.backend.supabase`.
 * Holds the public-ish `projectUrl` directly (safe to commit to git via
 * venture.yaml) and the **names** of the env vars that hold the anon +
 * service-role keys. The keys themselves NEVER live in the manifest.
 *
 * Resolution order at runtime (see resolveSupabaseCredentials):
 *   1. process env
 *   2. 12_backend/supabase/.credentials.json  (gitignored; written by
 *      the BackendTab "Paste credentials" modal in slice 7)
 *   3. Tauri keyring (slice 9+ follow-up; not in scope for this arc)
 */
export const SupabaseConfigSchema = z.object({
  projectUrl: z.string().url(),
  anonKeyEnvVar: z.string().default(SUPABASE_DEFAULT_ANON_KEY_ENV_VAR),
  serviceRoleKeyEnvVar: z
    .string()
    .default(SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR),
});
export type SupabaseConfig = z.infer<typeof SupabaseConfigSchema>;

/**
 * Resolved credentials -- what the provider actually uses for HTTPS.
 * Returned by resolveSupabaseCredentials() on the happy path.
 */
export type SupabaseCredentials = {
  projectUrl: string;
  anonKey: string;
  serviceRoleKey: string;
};

/**
 * Failure shape -- mirrors the discriminated-union return style used
 * elsewhere in backend-core / crm-core. `which` names the missing
 * piece so the BackendTab can render a precise "paste this env var"
 * message rather than a generic "credentials missing".
 */
export type SupabaseCredentialsError = {
  error: "missing-env-var";
  which: "anonKey" | "serviceRoleKey" | "projectUrl";
  envVarName?: string;
};

/**
 * Resolve credentials from a config + env snapshot. Pure -- no IO, no
 * keyring, no disk reads. Callers compose this with whatever env
 * snapshot they have (`process.env` from the runner side; a Tauri
 * command result from the WebView side).
 *
 * Empty strings are treated as missing -- a `.env.local` file with
 * `SUPABASE_ANON_KEY=` would otherwise resolve to "" and crash the
 * fetch much later with a confusing message.
 */
export function resolveSupabaseCredentials(
  config: SupabaseConfig,
  env: Record<string, string | undefined>
): SupabaseCredentials | SupabaseCredentialsError {
  if (!config.projectUrl || config.projectUrl.trim().length === 0) {
    return {
      error: "missing-env-var",
      which: "projectUrl",
    };
  }
  const anonKey = env[config.anonKeyEnvVar];
  if (anonKey === undefined || anonKey.trim().length === 0) {
    return {
      error: "missing-env-var",
      which: "anonKey",
      envVarName: config.anonKeyEnvVar,
    };
  }
  const serviceRoleKey = env[config.serviceRoleKeyEnvVar];
  if (serviceRoleKey === undefined || serviceRoleKey.trim().length === 0) {
    return {
      error: "missing-env-var",
      which: "serviceRoleKey",
      envVarName: config.serviceRoleKeyEnvVar,
    };
  }
  return {
    projectUrl: config.projectUrl,
    anonKey,
    serviceRoleKey,
  };
}

export const BackendAddonSchema = z.enum([
  "oauth_google",
  "oauth_github",
  "oauth_apple",
  "oauth_discord",
  "email_password_reset",
  "realtime_presence",
  "audit_log",
]);
export type BackendAddon = z.infer<typeof BackendAddonSchema>;

export const BackendConfigSchema = z.object({
  /**
   * Skip the BACKEND stage entirely. Set true for ventures with no
   * backend (marketing sites, pure-frontend extensions). The runner
   * emits a config_only export and short-circuits.
   */
  skip: z.boolean().default(false),
  /**
   * Resolver candidate list. Default is pocketbase -> drizzle_sqlite ->
   * config_only. Override to add supabase / convex / appwrite.
   */
  enabledEngines: z
    .array(BackendEngineSchema)
    .default([...BACKEND_ENGINE_TIERS_DEFAULT]),
  pocketbase: PocketbaseConfigSchema.optional(),
  addons: z.array(BackendAddonSchema).default([]),
  /**
   * Supabase per-venture config. Optional (only relevant when
   * `supabase` is in enabledEngines). Holds `projectUrl` directly and
   * env-var NAMES for the anon + service-role keys (the keys
   * themselves never live on disk under venture.yaml). See
   * SupabaseConfigSchema docstring + bizBuild/SUPABASE-MODULE-SPEC.md
   * sec 3 for the BYOP credentials flow.
   */
  supabase: SupabaseConfigSchema.optional(),
  /**
   * Hard cap on monthly hosting USD for this venture. Used by FINANCE
   * to gate advancement to LAUNCH when a hosted tier is selected.
   * Tier_0 PocketBase on $0 self-host or $5 Fly.io shared CPU is always
   * under cap; default is 0 (explicit opt-in to any paid hosting).
   */
  monthlyUsdCap: z.number().nonnegative().default(0),
});
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

// ---------------------------------------------------------------------------
// BackendInstance -- the pipeline's record of "what we provisioned"
// ---------------------------------------------------------------------------

export const BackendInstanceSchema = z.object({
  ventureSlug: z.string(),
  engine: BackendEngineSchema,
  /**
   * Resolved base URL after provisioning. http://127.0.0.1:<port> for
   * tier_0 PocketBase; hosted tiers fill in their cloud URL. Undefined
   * for config_only (no backend runs).
   */
  baseUrl: z.string().url().optional(),
  /**
   * Filesystem path to the venture's PocketBase binary (tier_0 only).
   * Undefined for hosted tiers.
   */
  binaryPath: z.string().optional(),
  /**
   * PocketBase version that was actually downloaded (resolved from the
   * "0.22.x" spec into a concrete patch). Set on tier_0 only.
   */
  resolvedVersion: z.string().optional(),
  adminEmail: z.string().email(),
  provisionedAt: z.string().datetime(),
  notes: z.string().optional(),
});
export type BackendInstance = z.infer<typeof BackendInstanceSchema>;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export type ProvisionOpts = {
  ventureSlug: string;
  ventureRoot: string;
  adminEmail: string;
  pocketbase?: PocketbaseConfig;
  supabase?: SupabaseConfig;
};

export type ApplySchemaOpts = {
  ventureRoot: string;
  baseUrl: string;
  collections: Collection[];
};

/**
 * Implemented by all engines (pocketbase + 4 stub tiers + config_only).
 * Slice 2 ships the PocketBase implementation; slice 1 only declares
 * the contract. The stub tiers expose this shape with available()=false
 * + render()/applySchema() that throws a typed NotImplementedError, so
 * the resolver never picks them but consumers can detect them.
 */
export interface BackendProvider {
  readonly name: BackendEngine;
  available(): Promise<boolean>;
  provision(opts: ProvisionOpts): Promise<BackendInstance>;
  applySchema(opts: ApplySchemaOpts): Promise<void>;
  export(instance: BackendInstance, collections: Collection[]): Promise<BackendExport>;
}

// ---------------------------------------------------------------------------
// Run-result envelope -- what the runner writes to backend-checkpoint.json
// ---------------------------------------------------------------------------

export const BackendCheckpointSchema = z.object({
  runId: z.string(),
  ventureSlug: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum([
    "in_progress",
    "completed",
    "failed",
    "awaiting_review",
    "skipped",
  ]),
  instance: BackendInstanceSchema.optional(),
  collectionsApplied: z.number().int().nonnegative().default(0),
  hooksGenerated: z.number().int().nonnegative().default(0),
  exportPath: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type BackendCheckpoint = z.infer<typeof BackendCheckpointSchema>;

// ---------------------------------------------------------------------------
// Parse helper re-exports -- the actual helpers live in parse.ts so callers
// can import the focused module if they want, but the barrel surface is the
// canonical entry point.
// ---------------------------------------------------------------------------

export {
  parseBackendConfig,
  safeParseBackendConfig,
  parseBackendInstance,
  safeParseBackendInstance,
  parseCollection,
  safeParseCollection,
  parseField,
  safeParseField,
  parseBackendExport,
  safeParseBackendExport,
  parseBackendCheckpoint,
  safeParseBackendCheckpoint,
  parseSupabaseConfig,
  safeParseSupabaseConfig,
} from "./parse.js";
