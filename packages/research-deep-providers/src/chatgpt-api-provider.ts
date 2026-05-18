/**
 * chatgpt-api provider — tier_1, OpenAI Responses API with web_search.
 *
 * Per spec §6 this fallback is **off by default**: the founder already
 * pays for ChatGPT Plus, and paying for the API on top is double-billing.
 * The orchestrator only constructs this provider when the founder
 * explicitly enables it in `venture.yaml` (or when chatgpt-sub paste-in is
 * deliberately disabled for batch warm-ups).
 *
 * Surface: POST to /v1/responses with the `web_search_preview` tool.
 * Response carries an `output` array of message blocks; we concatenate
 * `output_text` content items to reconstruct the markdown reply.
 *
 * CLIENT-SAFE — fetch-based, no node:* imports.
 */

import {
  parsePastedDeepResearch,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
} from "@founder-os/research-deep-core";
import {
  RESEARCH_WORKER_SYSTEM_PROMPT,
  buildWorkerUserPrompt,
} from "./prompts.js";

/** Default model — gpt-4.1 is the strongest Responses-API model with web_search. */
export const CHATGPT_API_DEFAULT_MODEL = "gpt-4.1";

/** Default API base. */
export const CHATGPT_API_DEFAULT_BASE_URL = "https://api.openai.com";

export interface CreateChatgptApiProviderOpts {
  /** OpenAI API key. Required. */
  apiKey: string;
  /** Override the model. Default: `gpt-4.1`. */
  model?: string;
  /** Override the base URL. */
  baseUrl?: string;
  /** Optional organization header value. */
  organization?: string;
  /**
   * Inject fetch. Default: globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  /** Per-call timeout (ms). Default: 180_000. */
  timeoutMs?: number;
  /**
   * Toggle the `web_search_preview` tool. Default true.
   */
  enableWebSearch?: boolean;
  /**
   * Probe. Default: returns true when `apiKey` is non-empty.
   */
  isAvailable?: () => Promise<boolean>;
}

export class ChatgptApiInvocationError extends Error {
  constructor(cause: string) {
    super(`chatgpt-api: ${cause}`);
    this.name = "ChatgptApiInvocationError";
  }
}

/**
 * Build a ChatGPT-API-backed `ResearchProvider`. Sources tagged
 * `retrievedBy: "chatgpt-api"`.
 */
export function createChatgptApiProvider(
  opts: CreateChatgptApiProviderOpts,
): ResearchProvider {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error(
      "createChatgptApiProvider: opts.apiKey is required (set OPENAI_API_KEY upstream)",
    );
  }

  const model = opts.model ?? CHATGPT_API_DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? CHATGPT_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const enableWebSearch = opts.enableWebSearch ?? true;
  const isAvailable = opts.isAvailable ?? (async () => true);

  return {
    name: "chatgpt-api",

    async available(): Promise<boolean> {
      try {
        return await isAvailable();
      } catch {
        return false;
      }
    },

    async researchTopic(topicOpts: ResearchTopicOpts): Promise<ProviderPartial> {
      const accessedAt = topicOpts.accessedAt ?? new Date().toISOString();
      const userPrompt = buildWorkerUserPrompt({
        topic: topicOpts.topic,
        questions: topicOpts.questions,
        ventureContext: topicOpts.ventureContext,
        accessedAt,
      });

      const body: Record<string, unknown> = {
        model,
        instructions: RESEARCH_WORKER_SYSTEM_PROMPT,
        input: userPrompt,
      };
      if (enableWebSearch) {
        body.tools = [{ type: "web_search_preview" }];
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      };
      if (opts.organization) headers["OpenAI-Organization"] = opts.organization;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const isAbort = (err as { name?: string } | null)?.name === "AbortError";
        throw new ChatgptApiInvocationError(
          isAbort
            ? `timeout after ${timeoutMs}ms`
            : `network error: ${stringifyError(err)}`,
        );
      }
      clearTimeout(timer);

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        const detail = extractOpenaiErrorMessage(parsed) ?? text.slice(0, 240);
        throw new ChatgptApiInvocationError(
          `HTTP ${response.status}: ${detail || "(no body)"}`,
        );
      }

      const markdown = extractOpenaiMarkdown(parsed);
      if (!markdown.trim()) {
        throw new ChatgptApiInvocationError(
          "Responses API returned no output_text content",
        );
      }

      const partial = parsePastedDeepResearch(markdown, {
        channel: "chatgpt-api",
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      return {
        ...partial,
        rawTranscript: {
          channel: "chatgpt-api",
          request: { model, body },
          response: parsed,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Extract the model's textual reply from a Responses-API response.
 *
 * The Responses API exposes both:
 *   - A flat `output_text` convenience field (when set).
 *   - A structured `output[]` array of message / tool-call items, where
 *     each message item has a `content[]` array of `{type: "output_text", text}` items.
 *
 * We prefer `output_text` when present (saves traversal) and fall back to
 * walking `output[]` for messages.
 */
function extractOpenaiMarkdown(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  // Convenience field.
  const flat = (parsed as { output_text?: unknown }).output_text;
  if (typeof flat === "string" && flat.trim()) return flat;

  const output = (parsed as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const i = item as { type?: unknown; content?: unknown };
    if (i.type !== "message") continue;
    if (!Array.isArray(i.content)) continue;
    for (const c of i.content) {
      if (!c || typeof c !== "object") continue;
      const cc = c as { type?: unknown; text?: unknown };
      if (
        (cc.type === "output_text" || cc.type === "text") &&
        typeof cc.text === "string"
      ) {
        parts.push(cc.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractOpenaiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}
