// Re-export the public constants from index.ts as a focused entry point
// for callers that only need defaults (e.g. the desktop app's CrmTab
// rendering "Active engine: …" before any provider has been resolved).
//
// Splitting these out matches the @founder-os/media-core convention
// where preset constants are reachable without pulling in the full
// schema surface.

export {
  CRM_ENGINE_TIERS_DEFAULT,
  CRM_HTTP_LOCAL_HOSTNAMES,
  CRM_DOCKER_DEFAULT_PORT,
  CRM_DOCKER_DEFAULT_SOCKETIO_PORT,
  CRM_DOCKER_DEFAULT_IMAGE,
  CRM_DOCKER_DEFAULT_DATA_DIR,
  CRM_BENCH_DEFAULT_SITE_URL,
} from "./index.js";
