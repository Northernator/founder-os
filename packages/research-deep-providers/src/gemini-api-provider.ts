/**
 * gemini-api provider — tier_1, programmatic Google AI Studio fallback.
 *
 * Fires when `gemini-sub` (the CLI channel) is unavailable AND the
 * orchestrator has been told the founder is happy paying for API calls in
 * addition to their subscription. Spec §6 marks this as the tier_1
 * fallback for the gemini lane.
 *
 * Surface: POST to /v1beta/models/<model>:generateContent with the
 * `googleSearch` tool enabled — Google's grounded-search equivalent of
 * Anthropic's web_search server tool. Grounded responses come back with
 * `candidates[0].content.parts[].text` plus `groundingMetadata.groundingChunks[].web.uri`.
 * We capture the URLs into the rawTranscript so the orchestrator's
 * cross-referencer can compare worker sources side-by-side; the parser
 * also picks up URLs from the prose / sources block via the shared
 * `parsePastedDeepResearch` heuristic.
 *
 * CLIENT-SAFE — fetch-based, no node:* imports.
 */

import {
  parsePastedDeepResearch,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
  type Source,
} from "@founder-os/research-deep-core";
import {
  RESEARCH_WORKER_SYSTEM_PROMPT,
  buildWorkerUserPrompt,
} from "./prompts.js";

/** Default model — Gemini 2.5 Pro is what `gemini-sub` lands on with Advanced. */
export const GEMINI_API_DEFAULT_MODEL = "gemini-2.5-pro";

/** Default base URL for Google's generative-language REST surface. */
export const GEMINI_API_DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com";

/** Default API version. v1beta is where googleSearch tool lives at time of writing. */
export const GEMINI_API_DEFAULT_VERSION = "v1beta";

export interface CreateGeminiApiProviderOpts {
  /**
   * Google AI Studio API key. Required. Read upstream — this module does
   * not touch process.env.
   */
  apiKey: string;
  /** Override the model. Default: `gemini-2.5-pro`. */
  model?: string;
  /** Override the base URL. */
  baseUrl?: string;
  /** Override the API version segment. Default: `v1beta`. */
  apiVersion?: string;
  /**
   * Inject fetch. Default: globalThis.fetch (Node 18+, Tauri, browser).
   */
  fetchImpl?: typeof fetch;
  /** Per-call timeout (ms). Default: 180_000. */
  timeoutMs?: number;
  /**
   * Toggle Google Search grounding. Default true — without it this channel
   * is just a memory-dump fallback.
   */
  enableGoogleSearch?: boolean;
  /**
   * Probe. Default: returns true when `apiKey` is non-empty. No round-trip.
   */
  isAvailable?: () => Promise<boolean>;
}

export class GeminiApiInvocationError extends Error {
  constructor(cause: string) {
    super(`gemini-api: ${cause}`);
    this.name = "GeminiApiInvocationError";
  }
}

/**
 * Build a Gemini-API-backed `ResearchProvider`. Same worker prompt as the
 * other channels; response markdown flows through the shared paste-in
 * parser. Sources tagged `retrievedBy: "gemini-api"`.
 */
export function createGeminiApiProvider(
  opts: CreateGeminiApiProviderOpts,
): ResearchProvider {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error(
      "createGeminiApiProvider: opts.apiKey is required (set GOOGLE_API_KEY upstream)",
    );
  }

  const model = opts.model ?? GEMINI_API_DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? GEMINI_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiVersion = opts.apiVersion ?? GEMINI_API_DEFAULT_VERSION;
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const enableGoogleSearch = opts.enableGoogleSearch ?? true;
  const isAvailable = opts.isAvailable ?? (async () => true);

  return {
    name: "gemini-api",

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
        systemInstruction: {
          role: "system",
          parts: [{ text: RESEARCH_WORKER_SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
      };
      if (enableGoogleSearch) {
        body.tools = [{ googleSearch: {} }];
      }

      const url =
        `${baseUrl}/${apiVersion}/models/${encodeURIComponent(model)}:generateContent` +
        `?key=${encodeURIComponent(opts.apiKey)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const isAbort = (err as { name?: string } | null)?.name === "AbortError";
        throw new GeminiApiInvocationError(
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
        const detail = extractGeminiErrorMessage(parsed) ?? text.slice(0, 240);
        throw new GeminiApiInvocationError(
          `HTTP ${response.status}: ${detail || "(no body)"}`,
        );
      }

      const markdown = extractGeminiMarkdown(parsed);
      if (!markdown.trim()) {
        throw new GeminiApiInvocationError("returned no text parts");
      }

      const partial = parsePastedDeepResearch(markdown, {
        channel: "gemini-api",
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      // Fold groundingMetadata URIs into the source set — they're the
      // strongest provenance signal the API gives us (model-attested rather
      // than text-scraped). Stamp them with the same accessedAt.
      const grounded = extractGroundingUris(parsed, accessedAt);
      const merged = mergeSources(partial.sources, grounded);

      return {
        ...partial,
        sources: merged,
        rawTranscript: {
          channel: "gemini-api",
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
 * Extract text-part content from a Gemini generateContent response. The
 * response is `{ candidates: [{ content: { parts: [{ text }, ...] } }, ...] }`.
 * We take the first candidate (n=1 unless overridden) and concatenate text
 * parts in order. Tool-call parts are ignored — googleSearch fires
 * server-side and the model produces its final answer in text parts.
 */
function extractGeminiMarkdown(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = candidates[0];
  if (!first || typeof first !== "object") return "";
  const content = (first as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const t = (part as { text?: unknown }).text;
    if (typeof t === "string") out.push(t);
  }
  return out.join("\n").trim();
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/**
 * Extract grounding URIs from candidates[0].groundingMetadata.groundingChunks.
 * These are the URLs Google's grounded-search actually fetched, so they're
 * the most trustworthy source attribution we get. Returns Source stubs
 * marked `retrievedBy: "gemini-api"`, trust tier secondary (Google search
 * is broad but not first-party — the cross-referencer can promote to
 * primary when the host is a regulator).
 */
function extractGroundingUris(parsed: unknown, accessedAt: string): Source[] {
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const first = candidates[0];
  if (!first || typeof first !== "object") return [];
  const gm = (first as { groundingMetadata?: unknown }).groundingMetadata;
  if (!gm || typeof gm !== "object") return [];
  const chunks = (gm as { groundingChunks?: unknown }).groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const out: Source[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks as GroundingChunk[]) {
    const uri = chunk?.web?.uri;
    if (!uri || typeof uri !== "string") continue;
    if (seen.has(uri)) continue;
    if (!isParseableUrl(uri)) continue;
    seen.add(uri);
    let host = uri;
    try {
      host = new URL(uri).hostname;
    } catch {
      /* keep uri as title fallback */
    }
    out.push({
      url: uri,
      title: chunk.web?.title ?? host,
      accessedAt,
      retrievedBy: "gemini-api",
      trustTier: "secondary",
    });
  }
  return out;
}

function mergeSources(parsed: Source[], grounded: Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const s of parsed) byUrl.set(s.url, s);
  // Grounded URIs win — they're more authoritative than what we scraped
  // from the prose (the model may have hallucinated those).
  for (const s of grounded) byUrl.set(s.url, s);
  return Array.from(byUrl.values());
}

function isParseableUrl(url: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function extractGeminiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}
