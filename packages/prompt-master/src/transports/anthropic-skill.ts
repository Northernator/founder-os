/**
 * Reference transport: Anthropic API + Prompt Master skill.
 *
 * Optional helper. The core package is transport-agnostic; this is one
 * concrete implementation, useful as the default in apps that already
 * have the Anthropic SDK on hand.
 *
 * Setup:
 *
 *   1. Install the SDK in the host app:
 *        pnpm -F <app> add @anthropic-ai/sdk
 *
 *   2. Wire it in at startup:
 *        import Anthropic from "@anthropic-ai/sdk";
 *        import { setTransport } from "@founder-os/prompt-master";
 *        import { createAnthropicSkillTransport } from
 *          "@founder-os/prompt-master/src/transports/anthropic-skill.js";
 *
 *        setTransport(createAnthropicSkillTransport({
 *          client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
 *          model: "claude-haiku-4-5-20251001",
 *        }));
 *
 * The system prompt below tells Claude to act like Prompt Master. If you've
 * installed the actual Prompt Master skill (https://github.com/nidrajcs/prompt-master)
 * into your Anthropic account, swap to a skill-aware client call instead and
 * delete the inline system text — keeping it short.
 *
 * This transport is a thin wrapper, not magic. If it doesn't fit your auth
 * model, copy + adapt — the contract is just `optimize(input) -> { optimized }`.
 */
import type { OptimizeInput, PromptMasterTransport } from "../types.js";

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

interface MinimalAnthropicMessages {
  create(args: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: "user"; content: string }[];
  }): Promise<{ content: { type: string; text?: string }[] }>;
}

interface MinimalAnthropicClient {
  messages: MinimalAnthropicMessages;
}

export interface AnthropicSkillTransportOpts {
  /** Anthropic SDK client instance. The host app owns the API key. */
  client: MinimalAnthropicClient;
  /** Model id to use for the optimization call itself. Haiku is plenty. */
  model?: string;
  /** Override the system prompt. Useful if Prompt Master ships a new prompt. */
  systemOverride?: string;
  /** Token cap for the optimized output. Defaults to roughly the input length. */
  maxTokens?: number;
}

export function createAnthropicSkillTransport(
  opts: AnthropicSkillTransportOpts,
): PromptMasterTransport {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const system = opts.systemOverride ?? PROMPT_MASTER_SYSTEM;

  return {
    name: "anthropic-skill",
    async optimize(input: OptimizeInput): Promise<{ optimized: string }> {
      const maxTokens = opts.maxTokens ?? Math.max(256, Math.ceil(input.prompt.length / 3));
      const resp = await opts.client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: input.prompt }],
      });
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      // Defensive: if the model returned nothing, treat as identity rather
      // than throwing — the core dispatcher will mark it fallback.
      return { optimized: text.length > 0 ? text : input.prompt };
    },
  };
}
