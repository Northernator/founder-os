/**
 * @founder-os/sales-agents/node -- Node-only entry point.
 *
 * Anything that needs node:fs / node:path / node:crypto / node:child_process
 * / pdfkit lives here, NOT in the root barrel ("./"). The Tauri WebView
 * imports the root barrel only -- this subpath would crash module
 * evaluation in the renderer (Vite externalises node:* into stubs that
 * throw on access). Mirrors the @founder-os/prompt-master split.
 *
 * Typical Node startup (CLI / sidecar / extension):
 *
 *   import { runSalesPipeline } from "@founder-os/sales-agents";
 *   import {
 *     NodeFsAdapter,
 *     createClaudeCliCallLlm,
 *     generateSalesReport,
 *     runOneProspect,
 *     runBatch,
 *   } from "@founder-os/sales-agents/node";
 */

export { NodeFsAdapter } from "./node/fs-adapter.js";
export { generateSalesReport, type GeneratePdfOpts } from "./node/pdf-generator.js";
export {
  createClaudeCliCallLlm,
  isClaudeCliAvailable,
  ClaudeCliNotFoundError,
  type ClaudeCliCallerOpts,
} from "./node/claude-cli-caller.js";
export {
  runOneProspect,
  type RunOneProspectOpts,
  type RunOneProspectResult,
} from "./node/run-prospect.js";
export {
  runBatch,
  type RunBatchOpts,
  type RunBatchResult,
  type ProspectEvent,
} from "./node/batch.js";
