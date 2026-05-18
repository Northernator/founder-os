/**
 * @founder-os/backend-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:fs / node:fs/promises /
 * node:path lives here, NOT in the root barrel ("./"). The Tauri
 * WebView imports the root barrel only -- this subpath would crash
 * module evaluation in the renderer (Vite externalises node:* into
 * stubs that throw on access).
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createPocketbaseProvider,
 *     createConfigOnlyProvider,
 *     pickActiveBackendProvider,
 *     resolveBinaryPath,
 *     binaryExists,
 *   } from "@founder-os/backend-providers/node";
 *
 * The WebView side ("@founder-os/backend-providers" root barrel) gives
 * you only the stub providers (Supabase/Convex/Appwrite/Drizzle), the
 * capabilities list, and the probe-result envelope. PocketBase has to
 * be driven from Node -- when invoked from the desktop app, that
 * happens via a Tauri command (slice 5b ships
 * backend_probe_pocketbase / backend_serve_dev / etc).
 */

// Subprocess primitives + error classes.
export {
  spawnPocketbase,
  spawnPocketbaseJson,
  PocketbaseExitError,
  PocketbaseNotFoundError,
  type PocketbaseSpawnOpts,
  type PocketbaseSpawnResult,
} from "./spawn.js";

// HTTP primitives + error classes.
export {
  authenticateAdmin,
  healthProbe,
  listCollections,
  PocketbaseAuthError,
  PocketbaseHealthError,
  PocketbaseHttpError,
  type AdminAuthOpts,
  type AdminAuthResult,
  type AuthorizedHttpOpts,
  type PocketbaseCollectionDto,
  type PocketbaseHttpOpts,
} from "./http.js";

// Binary lifecycle + path resolution.
export {
  binaryExists,
  downloadBinary,
  PocketbaseBinaryDownloadError,
  PocketbaseBinaryMissingError,
  resolveBinaryPath,
  resolveDownloadUrl,
  type DownloadBinaryOpts,
} from "./binary.js";

// Project lifecycle helpers.
export {
  bootstrapPocketbaseProject,
  buildSkeletalCollectionMigration,
  getPocketbasePaths,
  writeMigration,
  type BootstrapOpts,
  type PocketbasePaths,
  type WriteMigrationOpts,
} from "./ensure-project.js";

// Real PocketBase BackendProvider factory.
export {
  createPocketbaseProvider,
  type CreatePocketbaseProviderOpts,
} from "./pocketbase-provider.js";

// Always-available config_only provider.
export {
  createConfigOnlyProvider,
  type ConfigOnlyProviderOpts,
} from "./config-only-provider.js";

// Resolver -- picks first available provider from the tier list.
export {
  pickActiveBackendProvider,
  type ResolverInput,
  type ResolverResult,
} from "./resolver.js";
