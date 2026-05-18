/**
 * @founder-os/backend-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives the
 * PocketBase binary or makes HTTP calls lives in the "./node" subpath:
 *
 *   import {
 *     createPocketbaseProvider,
 *     createConfigOnlyProvider,
 *     pickActiveBackendProvider,
 *   } from "@founder-os/backend-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors @founder-os/media-providers, @founder-os/crm-providers,
 * and @founder-os/handoff-providers.
 *
 * Stub providers (Supabase / Convex / Appwrite / Drizzle) are pure
 * type-importing factories whose available() returns false and other
 * methods throw -- safe to ship in the client barrel until their
 * internals land in slice 7+.
 */

import type { BackendEngine } from "@founder-os/backend-core";

// ---------------------------------------------------------------------------
// Capabilities -- the WebView reads this to render the engine selector
// without spawning anything.
// ---------------------------------------------------------------------------

export type BackendProviderCapability = {
  engine: BackendEngine;
  label: string;
  description: string;
  /**
   * True for engines that run on the user's machine (pocketbase /
   * drizzle_sqlite / config_only). False for hosted tiers.
   */
  isLocal: boolean;
  /**
   * True if the engine needs the user to sign up for an external account
   * before it can be used. The UI surfaces this to keep the local-first
   * tier_0 default obviously different from the hosted alternatives.
   */
  requiresAccount: boolean;
};

export const BACKEND_PROVIDER_CAPABILITIES: ReadonlyArray<BackendProviderCapability> =
  [
    {
      engine: "pocketbase",
      label: "PocketBase",
      description:
        "Single Go binary, embedded SQLite, ~30MB. Auth + db + realtime + files. Free. Local-first.",
      isLocal: true,
      requiresAccount: false,
    },
    {
      engine: "supabase",
      label: "Supabase",
      description:
        "Hosted Postgres + auth + realtime + storage. Free tier covers prototypes; Pro tier from ~$25/month. BYOP: create the project at supabase.com, paste the URL + service-role key into the BackendTab.",
      isLocal: false,
      requiresAccount: true,
    },
    {
      engine: "convex",
      label: "Convex",
      description:
        "TS-native, reactive queries built-in. Hosted, free tier.",
      isLocal: false,
      requiresAccount: true,
    },
    {
      engine: "appwrite",
      label: "Appwrite",
      description:
        "Open-source BaaS. Self-host (Docker stack) or use Appwrite Cloud.",
      isLocal: false,
      requiresAccount: false,
    },
    {
      engine: "drizzle_sqlite",
      label: "Drizzle + SQLite",
      description:
        "DIY ORM + raw SQLite. No admin UI, no built-in auth. Embedded-app territory.",
      isLocal: true,
      requiresAccount: false,
    },
    {
      engine: "config_only",
      label: "Config only",
      description:
        "Emit schema only, no backend runs. Use for static sites / extensions that don't need a backend.",
      isLocal: true,
      requiresAccount: false,
    },
  ];

// ---------------------------------------------------------------------------
// Probe envelope -- what the Tauri side returns when the WebView asks
// "is this provider currently usable?". Mirrors CrmProviderProbeResult.
// ---------------------------------------------------------------------------

export type BackendProviderProbeResult = {
  engine: BackendEngine;
  available: boolean;
  /**
   * Free-form note rendered in the UI when available=false:
   *  - pocketbase: "binary not present at <path>"
   *  - supabase / convex / appwrite / drizzle_sqlite: "stub provider"
   *  - config_only: never unavailable; always undefined.
   */
  reason?: string;
};

// ---------------------------------------------------------------------------
// Supabase provider (REAL as of Supabase slice 3). Safe to expose in the
// client barrel because it has no `node:*` imports -- all IO goes through
// `fetch`, all string manipulation is plain JS. Constructors require a
// per-venture SupabaseConfig + an env snapshot; WebView callers reach the
// provider via Tauri commands in practice (slice 7).
// ---------------------------------------------------------------------------

export {
  createSupabaseProvider,
  EXEC_SQL_BOOTSTRAP_SQL,
  MissingExecSqlError,
  SupabaseBadCredentialsError,
  SupabaseHealthError,
  SupabaseHttpError,
  type CreateSupabaseProviderOpts,
  type SupabaseProviderOpts,
} from "./supabase-provider.js";

// ---------------------------------------------------------------------------
// Stub providers (safe to expose in the client barrel because they don't
// import node:*). The factory + error class + opts shape is the contract
// slice 7+ implementations will swap internals against.
// ---------------------------------------------------------------------------

export {
  createConvexProvider,
  ConvexNotImplementedError,
  type ConvexProviderOpts,
} from "./convex-provider.js";

export {
  createAppwriteProvider,
  AppwriteNotImplementedError,
  type AppwriteProviderOpts,
} from "./appwrite-provider.js";

export {
  createDrizzleSqliteProvider,
  DrizzleSqliteNotImplementedError,
  type DrizzleSqliteProviderOpts,
} from "./drizzle-sqlite-provider.js";
