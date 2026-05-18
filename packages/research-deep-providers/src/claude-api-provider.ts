/**
 * claude-api provider — tier_1, programmatic Anthropic API fallback.
 *
 * Surface: HTTPS POST to /v1/messages with the `web_search` server tool
 * enabled. Same prompt + parser as claude-sub — the only difference is the
 * transport. We reuse `createClaudeSubProvider` with
 * `channelOverride: "claude-api"` so the partial briefings stamp the right
 * channel onto sources and the orchestrator's cross-reference pass can tell
 * the API fallback apart from the subscription channel.
 *
 * CLIENT-SAFE — fetch-based, no node:* imports. The Node side passes its
 * own fetch (or a key-bearing wrapper); the WebView can construct the
 * provider too if we ever wire a desktop bridge that calls Anthropic
 * directly. Per spec §6, this fallback fires when claude-sub rate-limits.
 */

import type {
  CallLlm,
  ResearchProvider,
} from "@founder-os/research-deep-core";
import {
  createClaudeSubProvider,
  ClaudeSubInvocationError,
} from "./claude-sub-provider.js";

/** Default model — Sonnet 4.6 balances quality + cost for batched research. */
export const CLAUDE_API_DEFAULT_MODEL = "claude-sonnet-4-6";

/** Default max tokens — research replies can be ~3-5k tokens of markdown. */
export const CLAUDE_API_DEFAULT_MAX_TOKENS = 8192;

/** Default Anthropic API base. */
export const CLAUDE_API_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Anthropic API version pinned for the web_search tool surface. */
export const CLAUDE_API_DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export interface CreateClaudeApiProviderOpts {
  /**
   * Anthropic API key. Required. Read from the host's env / Tauri config
   * BEFORE constructing — this module does not touch process.env.
   */
  apiKey: string;
  /** Override the model. Default: `claude-sonnet-4-6`. */
  model?: string;
  /** Override max output tokens. Default: 8192. */
  maxTokens?: number;
  /** Override the API base URL (e.g. for proxy / staging). */
  baseUrl?: string;
  /** Override the Anthropic API version header. */
  anthropicVersion?: string;
  /**
   * Inject a fetch override. Default: globalThis.fetch (works in Node 18+,
   * Tauri WebView, browsers). Tests pass a vi.fn().
   */
  fetchImpl?: typeof fetch;
  /** Per-call timeout (ms). Default: 180_000 (deep research is slow). */
  timeoutMs?: number;
  /**
   * Toggle the `web_search` server tool. Default true — the whole point of
   * this channel is sourced research, not a memory dump. The orchestrator
   * leaves this on; tests disable it to keep the request body simple.
   */
  enableWebSearch?: boolean;
  /**
   * Maximum number of search calls Anthropic should make per request.
   * Default: 5. Matches the rec'd cap in Anthropic's web_search docs.
   */
  maxWebSearchUses?: number;
  /**
   * Probe that returns true when the API is reachable AND the key is
   * present. Default: returns true when `apiKey` is non-empty (we don't
   * make a real round-trip — that would burn quota).
   */
  isAvailable?: () => Promise<boolean>;
}

/** Re-export the shared error class so callers can `instanceof` cleanly. */
export { ClaudeSubInvocationError as ClaudeApiInvocationError };

/**
 * Build a Claude-API-backed `ResearchProvider`. Wraps the shared claude-sub
 * provider; only the transport differs. Sources and sections come back
 * tagged with `retrievedBy: "claude-api"`.
 */
export function createClaudeApiProvider(
  opts: CreateClaudeApiProviderOpts,
): ResearchProvider {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error(
      "createClaudeApiProvider: opts.apiKey is required (set ANTHROPIC_API_KEY upstream)",
    );
  }

  const model = opts.model ?? CLAUDE_API_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? CLAUDE_API_DEFAULT_MAX_TOKENS;
  const baseUrl = (opts.baseUrl ?? CLAUDE_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const anthropicVersion =
    opts.anthropicVersion ?? CLAUDE_API_DEFAULT_ANTHROPIC_VERSION;
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const enableWebSearch = opts.enableWebSearch ?? true;
  const maxWebSearchUses = opts.maxWebSearchUses ?? 5;
  const isAvailable = opts.isAvailable ?? (async () => true);

  const callLlm: CallLlm = async ({ system, user }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    };
    if (enableWebSearch) {
      body.tools = [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: maxWebSearchUses,
        },
      ];
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": anthropicVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as { name?: string } | null)?.name === "AbortError";
      throw new ClaudeSubInvocationError(
        isAbort
          ? `claude-api timeout after ${timeoutMs}ms`
          : `claude-api network error: ${stringifyError(err)}`,
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
      const detail = extractAnthropicErrorMessage(parsed) ?? text.slice(0, 240);
      throw new ClaudeSubInvocationError(
        `claude-api HTTP ${response.status}: ${detail || "(no body)"}`,
      );
    }

    const markdown = extractAnthropicMarkdown(parsed);
    if (!markdown.trim()) {
      throw new ClaudeSubInvocationError(
        "claude-api returned no text content blocks",
      );
    }
    return markdown;
  };

  return createClaudeSubProvider({
    callLlm,
    isAvailable,
    channelOverride: "claude-api",
  });
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
 * Extract the markdown body from an Anthropic Messages-API response. The
 * server may interleave `text`, `server_tool_use`, and
 * `web_search_tool_result` content blocks when web_search fires; we
 * concatenate the text blocks in order. Tool-use / tool-result blocks are
 * ignored — they're protocol scaffolding, not part of the model's reply.
 */
function extractAnthropicMarkdown(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

function extractAnthropicErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message === "string") return message;
  return undefined;
}
