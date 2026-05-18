/**
 * @founder-os/research-deep-providers public entry — CLIENT-SAFE.
 *
 * This barrel imports ZERO node:* modules. Anything that drives a CLI
 * subprocess (gemini-cli) lives in the "./node" subpath:
 *
 *   import { createGeminiSubProvider } from "@founder-os/research-deep-providers/node";
 *
 * Why split: the Tauri WebView (and any other browser-like consumer)
 * bundles this barrel via Vite. If Node-only code reached this file Vite
 * would externalise the node:* imports and the resulting stubs throw on
 * access, crashing React mount before any UI renders. Mirrors the
 * @founder-os/prompt-master, @founder-os/sales-agents, and
 * @founder-os/media-providers splits.
 *
 * What lives here (client-safe):
 *   - claude-sub: consumes an injected CallLlm — pure, no node:*. The host
 *     wires whichever transport.
 *   - chatgpt-sub: paste-in only. The UI bridge supplies the
 *     RequestPasteIn callback that drives the review gate.
 *   - paste-in: generic always-works fallback. Same shape as chatgpt-sub.
 *   - shared prompt builders (RESEARCH_WORKER_SYSTEM_PROMPT,
 *     buildWorkerUserPrompt, buildPasteInPromptMarkdown).
 *
 * What lives in "./node":
 *   - gemini-sub: spawns gemini-cli. Node-only.
 *   - The gemini-cli spawn helpers + errors.
 */

// Shared prompt building blocks — safe everywhere.
export {
  RESEARCH_WORKER_SYSTEM_PROMPT,
  buildWorkerUserPrompt,
  buildPasteInPromptMarkdown,
} from "./prompts.js";

// claude-sub provider (factory consumes an injected CallLlm).
export {
  createClaudeSubProvider,
  ClaudeSubInvocationError,
  type CreateClaudeSubProviderOpts,
} from "./claude-sub-provider.js";

// chatgpt-sub paste-in provider.
export {
  createChatgptSubProvider,
  ChatgptSubSkippedError,
  type CreateChatgptSubProviderOpts,
} from "./chatgpt-sub-provider.js";

// Generic always-works paste-in fallback.
export {
  createPasteInProvider,
  type CreatePasteInProviderOpts,
} from "./paste-in-provider.js";
