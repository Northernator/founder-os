/**
 * Prompt Master transport that reuses the desktop app's streamChat.
 *
 * Optimization runs through whatever provider the user already has active -
 * Claude CLI subscription (OAuth via `claude login`), an Anthropic API key,
 * OpenAI, Gemini, DeepSeek, Grok, Kimi, Perplexity, or Ollama. Whichever
 * pickActiveProvider() returns is what gets used for the optimizer call.
 *
 * No separate ANTHROPIC_API_KEY config required. If the user has nothing
 * configured, pickActiveProvider returns null and the transport short-circuits
 * to identity (returns input unchanged) - the core dispatcher then marks it
 * as a fallback and the call sites still work.
 *
 * This is the right transport for founder-desktop. The VS Code extensions
 * use createClaudeCliTransport instead because they don't have access to the
 * Tauri-side llm_stream command.
 */
import { getProvider } from "@founder-os/llm-providers";
import type { OptimizeInput, PromptMasterTransport } from "@founder-os/prompt-master";
import * as db from "./db.js";
import { pickActiveProvider, streamChat } from "./llm-client.js";

const PROMPT_MASTER_SYSTEM = `You are Prompt Master, a lossless prompt optimizer.

Your job: rewrite the user's prompt to use fewer tokens while preserving every
instruction, constraint, format requirement, and example. Do NOT drop content.
Do NOT paraphrase examples. Do NOT change meaning.

Output ONLY the optimized prompt. No explanation, no preamble, no metadata.

Rules:
- Use crisp imperative phrasing.
- Collapse redundant phrasing ("please make sure to" -> "must").
- Combine adjacent rules into a single sentence when meaning is preserved.
- Preserve all variable placeholders (e.g. {{name}}, [field]) verbatim.
- Preserve XML tags, code fences, and JSON shape examples verbatim.
- If the input is already minimal, return it unchanged.`;

export interface StreamChatTransportOpts {
  /** Override the system prompt. Default is the Prompt Master instruction set. */
  systemOverride?: string;
  /**
   * Per-venture override - if you want optimization scoped to a specific
   * venture's saved provider preference. Omit for the global active provider.
   */
  ventureId?: string;
  /** Token cap. Default scales with input length. */
  maxTokens?: number;
}

export function createStreamChatTransport(
  opts: StreamChatTransportOpts = {}
): PromptMasterTransport {
  const system = opts.systemOverride ?? PROMPT_MASTER_SYSTEM;

  return {
    name: "stream-chat",
    async optimize(
      input: OptimizeInput
    ): Promise<{ optimized: string; provider?: string; model?: string }> {
      const provider = await pickActiveProvider(opts.ventureId);
      if (!provider) {
        // No usable provider - core dispatcher marks this as fallback.
        // Skip provider/model — there's no real backend to attribute
        // these zero-token-saved events to.
        return { optimized: input.prompt };
      }

      // Resolve which model the call will run under so telemetry can
      // tag the event for per-model dollar pricing. The user can leave
      // model unset in Options; fall back to the catalog default for
      // that provider so we still record a meaningful attribution
      // instead of NULL → fallback bucket. Best-effort: a DB read
      // failure here shouldn't break optimization, so we swallow.
      let model: string | undefined;
      try {
        const setting = await db.getLlmSetting(provider);
        const fromSetting = setting?.model?.trim();
        model =
          fromSetting && fromSetting.length > 0 ? fromSetting : getProvider(provider).defaultModel;
      } catch {
        model = getProvider(provider).defaultModel;
      }

      const maxTokens = opts.maxTokens ?? Math.max(256, Math.ceil(input.prompt.length / 3));

      const text = await streamChat({
        provider,
        system,
        messages: [{ role: "user", content: input.prompt }],
        maxTokens,
      });

      const trimmed = text.trim();
      // Defensive: empty -> identity (core marks fallback). We still
      // return provider/model so the optimize emit (when not
      // passthrough) tags the row.
      return {
        optimized: trimmed.length > 0 ? trimmed : input.prompt,
        provider,
        model,
      };
    },
  };
}
