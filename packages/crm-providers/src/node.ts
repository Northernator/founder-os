/**
 * @founder-os/crm-providers/node -- Node-only entry point.
 *
 * Anything that needs node:child_process / node:http / node:fs lives here,
 * NOT in the root barrel ("./"). The Tauri WebView imports the root barrel
 * only -- this subpath would crash module evaluation in the renderer (Vite
 * externalises node:* into stubs that throw on access).
 *
 * Local-only by construction: createFrappeClient refuses to send a request
 * to any hostname outside CRM_HTTP_LOCAL_HOSTNAMES. Removing or extending
 * that list is a code change, not a config flag.
 *
 * Typical Node startup (CLI / sidecar / Tauri-spawned subprocess):
 *
 *   import {
 *     createFrappeDockerProvider,
 *     createFrappeBenchProvider,
 *     createConfigOnlyProvider,
 *     pickActiveCrmProvider,
 *     createFrappeClient,
 *   } from "@founder-os/crm-providers/node";
 */

// HTTP primitives + error classes + host guard.
export {
  createFrappeClient,
  FrappeNonLocalHostError,
  FrappeHttpError,
  FrappeAuthError,
  type FrappeClient,
  type FrappeClientOpts,
  type FrappeRequestOpts,
} from "./frappe-client.js";

// Docker spawn helpers (slice 7 fills in the bootstrap orchestrator).
export {
  spawnDocker,
  spawnDockerJson,
  DockerNotFoundError,
  DockerExitError,
  type DockerSpawnOpts,
  type DockerSpawnResult,
} from "./spawn.js";

// Three providers + resolver.
export {
  createFrappeDockerProvider,
  DockerBootstrapNotImplementedError,
  type FrappeDockerProviderOpts,
  type DockerBootstrapContext,
  type DockerBootstrapHandoff,
} from "./frappe-docker-provider.js";

export {
  createFrappeBenchProvider,
  type FrappeBenchProviderOpts,
} from "./frappe-bench-provider.js";

export {
  createConfigOnlyProvider,
  type ConfigOnlyProviderOpts,
} from "./config-only-provider.js";

export {
  pickActiveCrmProvider,
  type ResolverInput,
  type ResolverResult,
} from "./resolver.js";

// Slice 7: Docker bootstrap orchestrator.
export {
  bootstrapDockerStack,
  DockerBootstrapTimeoutError,
  DockerBootstrapInstallError,
  type DockerBootstrapOpts,
  type DockerBootstrapResult,
  type FileWriter,
} from "./docker-bootstrap.js";
