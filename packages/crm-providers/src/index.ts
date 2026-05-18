/**
 * @founder-os/crm-providers public entry -- CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives the
 * Frappe REST client or the Docker CLI lives in the "./node" subpath:
 *
 *   import {
 *     createFrappeDockerProvider,
 *     createFrappeBenchProvider,
 *     createConfigOnlyProvider,
 *     pickActiveCrmProvider,
 *   } from "@founder-os/crm-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. The split makes
 * the boundary a hard import-path error instead of a silent runtime
 * crash. Mirrors the @founder-os/media-providers / @founder-os/sales-agents
 * splits.
 *
 * Local-only guarantee: even the Node entry point refuses to call
 * non-local hosts. The HTTP guard in frappe-client.ts rejects any
 * hostname outside CRM_HTTP_LOCAL_HOSTNAMES before opening a socket.
 *
 * The client-safe barrel exports:
 *   - Provider capability flags (so the WebView can render the right
 *     UI without spawning anything).
 *   - Re-exports of the CrmProvider type + tier-resolver result types
 *     from crm-core for ergonomic consumption.
 */

import type { CrmEngine } from "@founder-os/crm-core";

/**
 * What the WebView knows about each provider without doing any work.
 * The actual `available()` probes live in /node and are reached via
 * Tauri commands (see apps/founder-desktop/src-tauri/src/crm.rs).
 */
export type CrmProviderCapability = {
  engine: CrmEngine;
  /**
   * Human-readable name for the engine pill in the UI.
   */
  label: string;
  /**
   * One-line description rendered under the EnginesRow checkbox.
   */
  description: string;
  /**
   * Whether this engine ever calls localhost HTTP. config_only is
   * false; the other two are true. Used to decide whether the
   * "Local stack status" row is meaningful.
   */
  usesHttp: boolean;
};

export const CRM_PROVIDER_CAPABILITIES: ReadonlyArray<CrmProviderCapability> = [
  {
    engine: "frappe_docker",
    label: "Docker",
    description: "Local Frappe + CRM via Docker compose. Recommended default.",
    usesHttp: true,
  },
  {
    engine: "frappe_bench",
    label: "Bench",
    description: "Native frappe-bench install on this machine.",
    usesHttp: true,
  },
  {
    engine: "config_only",
    label: "Config only",
    description: "Write JSON exports only -- never call HTTP.",
    usesHttp: false,
  },
];

/**
 * Result of asking the Tauri side which providers are currently usable.
 * Mirrors the shape of MediaProviderProbeResult from media-providers but
 * for CRM. The WebView consumes this; the Node side populates it via
 * the real availability probes.
 */
export type CrmProviderProbeResult = {
  engine: CrmEngine;
  available: boolean;
  /**
   * Free-form note rendered in the UI when available=false:
   *  - frappe_docker: "Docker daemon not reachable"
   *  - frappe_bench: "No site responding on http://localhost:8000"
   *  - config_only: never unavailable; always undefined here.
   */
  reason?: string;
};
