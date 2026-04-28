/**
 * Prompt Master initialisation for the desktop app.
 *
 * Wires up a transport that reuses the user's existing LLM provider auth
 * via streamChat / pickActiveProvider. Whichever provider the user has
 * active (Claude CLI OAuth, Anthropic API key, OpenAI, Gemini, etc) is
 * what the optimizer uses. No separate API key needed.
 *
 * If the user has no provider configured, pickActiveProvider returns null,
 * the transport short-circuits to identity, and optimize() returns the
 * input unchanged with fallbackUsed=true. Call sites still work.
 */
import { setTransport } from "@founder-os/prompt-master";
import { createStreamChatTransport } from "./prompt-master-stream-transport.js";

export function initPromptMaster(): void {
  setTransport(createStreamChatTransport());
  console.info(
    "[prompt-master] stream-chat transport registered (uses active LLM provider auth)",
  );
}
