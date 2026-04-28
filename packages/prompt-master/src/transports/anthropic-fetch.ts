/**
 * Reference transport: Anthropic API + Prompt Master, via plain `fetch`.
 *
 * Why a fetch variant in addition to anthropic-skill.ts: the desktop app
 * runs in a Tauri WebView, not Node. The Anthropic SDK works there but
 * needs `dangerouslyAllowBrowser: true` and adds ~50 KB. A vanilla `fetch`
 * call avoids both. Same behaviour, no dep.
 *
 * Use in:
 *   - Tauri WebViews
 *   - Service workers
 *   - Browser extensions
 *   - Any environment with `fetch` and no Node SDK on hand
 *
 * Setup:
 *   import { setTransport } from "@founder-os/prompt-master";
 *   import { createAnthropicFetchTransport }
 *     from "@founder-os/prompt-master/src/transports/anthropic-fetch.js";
 *
 *   setTransport(createAnthropicFetchTransport({
 *     apiKey: anthropicApiKey,           // from your settings store
 *     model: "claude-haiku-4-5-20251001",
 *   }));
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

const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicFetchTransportOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  systemOverride?: string;
  maxTokens?: number;
}

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
}

export function createAnthropicFetchTransport(
  opts: AnthropicFetchTransportOpts
): PromptMasterTransport {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  const system = opts.systemOverride ?? PROMPT_MASTER_SYSTEM;

  return {
    name: "anthropic-fetch",
    async optimize(input: OptimizeInput): Promise<{ optimized: string }> {
      const maxTokens = opts.maxTokens ?? Math.max(256, Math.ceil(input.prompt.length / 3));
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: input.prompt }],
        }),
      });

      if (!resp.ok) {
        // Throw — the core dispatcher catches and falls back to identity.
        const body = await resp.text().catch(() => "");
        throw new Error(`anthropic-fetch: ${resp.status} ${resp.statusText} ${body.slice(0, 200)}`);
      }

      const json = (await resp.json()) as AnthropicMessageResponse;
      const text = (json.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();

      return { optimized: text.length > 0 ? text : input.prompt };
    },
  };
}
