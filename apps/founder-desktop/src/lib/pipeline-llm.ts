/**
 * pipeline-llm.ts (pt.27, extended pt.29) — adapter that wraps
 * `streamChat` into the `OrchestratorLlmCaller` shape expected by
 * `runPipeline` and the SaaS research-reports step.
 *
 * Why a separate module: two call sites need the same shape today —
 *  - `runPipeline` (brand LLM steps in pt.27)
 *  - `createSaasResearchReportsStep` (research-reports generator)
 * Both need a curried `({system, user}) => Promise<string>`. The helper
 * resolves the provider once (so all calls within a single run hit the
 * same provider) and returns a small closure either caller can invoke
 * as many times as it needs.
 *
 * If no provider is configured we return `null`; callers should treat
 * that as "skip / surface an error" rather than throw — the brand path
 * lets the orchestrator skip the LLM steps automatically; the research
 * path surfaces a "configure a provider" toast.
 *
 * The web-search opts (pt.29) exist because research reports want
 * server-side search to pull current data (competitor pricing, market
 * sizing, recent funding rounds), while the brand pipeline does not.
 * Default off, so the pt.27 brand-pipeline path is byte-equivalent.
 */
import type { OrchestratorLlmCaller } from "@founder-os/pipeline-runner";
import type { LlmProviderId } from "@founder-os/llm-providers";
import { streamChat, pickActiveProvider } from "./llm-client.js";

export type BuildPipelineLlmCallerOpts = {
  /**
   * Venture id for per-venture provider override resolution. The
   * orchestrator scopes a single pipeline run to one venture, so
   * resolving once at the start is correct — every LLM call within the
   * run uses the same provider.
   */
  ventureId: string;
  /**
   * Optional abort signal. The same signal is captured by the closure
   * and fans out across every `streamChat` invoked through this
   * adapter — abort once and every in-flight call cancels (including
   * the 4 parallel logo-concept calls in the brand pipeline, and the
   * 4 parallel report calls in the SaaS reports generator). Wired by
   * `handleRunPipeline` (pt.28) and `handleGenerateResearchReports`
   * (pt.29). Omit when you don't need cancellation.
   */
  signal?: AbortSignal;
  /**
   * Token cap forwarded to `streamChat`. 2000 covers both the naming
   * step (~1200 token JSON) and concept briefs (~1600 token markdown)
   * with headroom. Override per-caller if you have a step that needs
   * more.
   */
  maxTokens?: number;
  /**
   * Temperature forwarded to `streamChat`. 0.7 matches the BrandTab's
   * direct invocations of the same prompts (consistent vibe across the
   * two paths).
   */
  temperature?: number;
  /**
   * pt.29: enable server-side web search per call. Honoured only by
   * providers whose catalog entry has `supportsWebSearch === true`
   * (today: Anthropic only, web_search_20250305) — silently ignored
   * elsewhere by `streamChat`. Default `false` so the brand-pipeline
   * path is unchanged from pt.27. Research reports flip it on because
   * the whole point of those reports is to surface current data.
   */
  enableWebSearch?: boolean;
  /**
   * Upper bound on web searches per request. Forwarded only when
   * `enableWebSearch` is true. Defaults to whatever `streamChat`
   * defaults to (5 today) so callers who flip web-search on without
   * specifying a cap get sensible behavior.
   */
  webSearchMaxUses?: number;
};

export type BuildPipelineLlmCallerResult = {
  provider: LlmProviderId;
  callLlm: OrchestratorLlmCaller;
};

/**
 * Build a pipeline LLM caller. Returns null when no provider is usable
 * (no key saved, no enabled provider, etc.) — caller should treat that
 * as "skip LLM steps" rather than an error: the deterministic pipeline
 * still runs.
 */
export async function buildPipelineLlmCaller(
  opts: BuildPipelineLlmCallerOpts
): Promise<BuildPipelineLlmCallerResult | null> {
  const provider = await pickActiveProvider(opts.ventureId);
  if (!provider) return null;

  const maxTokens = opts.maxTokens ?? 2000;
  const temperature = opts.temperature ?? 0.7;

  const enableWebSearch = opts.enableWebSearch === true;
  const webSearchMaxUses = enableWebSearch ? opts.webSearchMaxUses : undefined;

  const callLlm: OrchestratorLlmCaller = async ({ system, user }) => {
    // Single-user-message shape — the orchestrator steps build a
    // self-contained prompt rather than threading a multi-turn chat,
    // which keeps the adapter trivial and provider-agnostic.
    return streamChat({
      provider,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens,
      temperature,
      signal: opts.signal,
      // Only forward the web-search flag explicitly when enabled —
      // mirrors `streamChat`'s own elide-when-false logic so non-
      // Anthropic providers don't see an irrelevant field.
      enableWebSearch: enableWebSearch ? true : undefined,
      webSearchMaxUses,
    });
  };

  return { provider, callLlm };
}
