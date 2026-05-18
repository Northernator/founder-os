/**
 * AI-write caption helper for the social compose modal.
 *
 * Slice 8 of the SOCIAL-MODULE follow-up arc. The deferred follow-up the
 * memory describes:
 *
 * > social-poster exposes an optional OpenAI integration for AI-written
 * > captions; calling that today bypasses the Founder OS LLM gateway and
 * > bills directly to whatever OPENAI_API_KEY is in your env, ignoring
 * > subscription-preferred routing.
 *
 * Fix: when the founder clicks "AI write" in the compose modal, route
 * the generation through `streamChat` + `pickActiveProvider`, which
 * honour the subscription-preferred + per-venture provider settings the
 * rest of Founder OS already obeys. social-poster never sees an OpenAI
 * key; the adapter only ever gets a finished caption via --text-file.
 */
import { pickActiveProvider, streamChat } from "./llm-client.js";

export type GenerateSocialCaptionOpts = {
  /** Venture id -- forwarded to pickActiveProvider so per-venture overrides apply. */
  ventureId?: string;
  /** Existing caption text the user has typed (may be empty). Used as a hint. */
  baseText: string;
  /** Platforms the post will go to. Caption is tuned to the tightest cap. */
  platforms: ReadonlyArray<string>;
  /** Tightest platform cap so the LLM stays under it. */
  capChars: number;
  /** Optional venture slug / brand voice hint. */
  ventureSlug?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
};

export class NoLlmProviderAvailableError extends Error {
  override readonly name = "NoLlmProviderAvailableError";
  constructor() {
    super(
      "No LLM provider configured. Open Options -> LLM providers to enable " +
        "subscription mode or paste an API key, then try AI write again.",
    );
  }
}

/**
 * Ask the active LLM (subscription-preferred) to draft a caption.
 * Resolves with the generated text. Throws NoLlmProviderAvailableError
 * when no provider is wired up; throws an AbortError when cancelled.
 */
export async function generateSocialCaption(
  opts: GenerateSocialCaptionOpts,
): Promise<string> {
  const provider = await pickActiveProvider(opts.ventureId);
  if (!provider) {
    throw new NoLlmProviderAvailableError();
  }

  const platformList = opts.platforms.join(", ");
  const system = [
    "You are a social-media copywriter for an indie SaaS founder. Write one",
    "tight, on-voice caption that works across the named platforms. No",
    "emoji unless the founder's existing draft already uses them. No",
    "hashtags inside the caption -- the founder adds them separately.",
    "Stay under the character cap.",
    "",
    `Platforms: ${platformList}`,
    `Character cap: ${opts.capChars}`,
    opts.ventureSlug ? `Venture: ${opts.ventureSlug}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = opts.baseText.trim()
    ? `Rewrite or improve this draft, keeping the founder's voice:\n\n${opts.baseText}`
    : `Draft a launch-day caption for the ${opts.ventureSlug ?? "venture"}. Keep it tight and human.`;

  const text = await streamChat({
    provider,
    system,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.7,
    maxTokens: Math.min(800, Math.ceil(opts.capChars * 1.2)),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return text.trim();
}
