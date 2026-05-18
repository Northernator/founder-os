// Re-export the public constants from index.ts as a focused entry point
// for callers that only need defaults (e.g. the desktop app's BackendTab
// rendering "Active engine: ..." before any provider has been resolved).
//
// Splitting these out matches the @founder-os/media-core and
// @founder-os/crm-core convention where preset constants are reachable
// without pulling in the full schema surface.

export {
  BACKEND_ENGINE_TIERS_DEFAULT,
  BACKEND_ENGINE_MONTHLY_USD_ESTIMATE,
  estimatedMonthlyHostingUsd,
  POCKETBASE_DEFAULT_VERSION,
  POCKETBASE_DEFAULT_PORT,
  POCKETBASE_DOWNLOAD_BASE,
} from "./index.js";
