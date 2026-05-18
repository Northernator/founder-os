/**
 * Generic paste-in provider — tier_3, the always-works fallback.
 *
 * Same shape as chatgpt-sub but channel-tagged as "paste-in", with a
 * neutral hint ("Paste into any LLM with web search…"). The orchestrator
 * uses this when every other channel fails — degraded, but the founder
 * can still feed a research artefact in by hand and the pipeline keeps
 * moving.
 *
 * Sources collected through paste-in default to `trustTier: tertiary`
 * (we can't verify they came from a real web fetch). The cross-referencer
 * weights tertiary sources lower in the synthesiser; the founder can
 * override per-source in the UI.
 *
 * Internally this is the same factory as chatgpt-sub, just with the
 * channel tag swapped — extracted to its own export so the orchestrator
 * can address it by name.
 */

import type {
  RequestPasteIn,
  ResearchProvider,
} from "@founder-os/research-deep-core";
import { createChatgptSubProvider } from "./chatgpt-sub-provider.js";

export interface CreatePasteInProviderOpts {
  /** Same shape as chatgpt-sub's callback — the UI bridge supplies it. */
  requestPaste: RequestPasteIn;
  /**
   * Optional channel hint shown in the gate UI. Default: a neutral
   * "Paste this into any LLM with web search / deep research."
   */
  channelHint?: string;
}

/**
 * Build a generic paste-in `ResearchProvider`. Always-available; emits
 * sources at `trustTier: tertiary` (handled inside the shared parser).
 */
export function createPasteInProvider(
  opts: CreatePasteInProviderOpts,
): ResearchProvider {
  return createChatgptSubProvider({
    requestPaste: opts.requestPaste,
    channelHint:
      opts.channelHint ??
      "any LLM with web search or deep research (Claude.ai, ChatGPT, Gemini, Perplexity)",
    channelOverride: "paste-in",
  });
}
