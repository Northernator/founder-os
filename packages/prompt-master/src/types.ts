/**
 * Public type contract for @founder-os/prompt-master.
 *
 * Every surface that uses the optimizer (handoff-sdk-runner, llm-client,
 * the Python research service via mirror) speaks this same shape. Keep this
 * file source-of-truth — the Python types in
 * services/research-py/src/research_py/prompt_master/core.py mirror it.
 */

/**
 * Free-text label categorising where the prompt comes from. Used for
 * telemetry grouping and (eventually) per-context tuning. Keep these short
 * and stable — they're keys in dashboards.
 */
export type PromptContext =
  | "handoff"
  | "wireframe"
  | "research"
  | "audit"
  | "system"
  | "venture-chat"
  | "other";

export interface OptimizeInput {
  /** The assembled prompt string. System or user. */
  prompt: string;
  /** Where this prompt comes from. Defaults to "other". */
  context?: PromptContext;
  /**
   * Target model id. Some models compress better with different conventions
   * (e.g. Claude prefers XML tags, GPT prefers headings). When omitted, the
   * optimizer uses model-agnostic compression.
   */
  model?: string;
  /**
   * 0.0 = strictly lossless (default), 0.05 = up to 5% acceptable info loss.
   * The optimizer treats this as a budget — it'll compress further if it can
   * stay within budget, otherwise stops.
   */
  maxLossBudget?: number;
  /**
   * Override the auto-computed cache key. Rarely needed; useful when the
   * prompt contains a per-call value (timestamp, request id) that should be
   * excluded from the hash.
   */
  cacheKey?: string;
}

export interface OptimizeResult {
  /** The optimized prompt. Equals input when fallbackUsed is true. */
  optimized: string;
  /** Estimated tokens saved (post-compress vs pre-compress, rough heuristic). */
  tokensSaved: number;
  /** True if the result came from cache rather than a fresh optimizer call. */
  cacheHit: boolean;
  /**
   * True if the Prompt Master transport was unavailable and we returned the
   * input prompt unchanged. Callers can ignore this — the system still works.
   */
  fallbackUsed: boolean;
  /** Diagnostic data — hash, latency, transport name. */
  trace: {
    hash: string;
    latencyMs: number;
    transport: string;
  };
}

/**
 * Pluggable transport interface. The default null transport returns input
 * unchanged. Callers wire in a real transport (Anthropic API + skill, local
 * binary, HTTP service) at app startup via `setTransport()`.
 */
export interface PromptMasterTransport {
  readonly name: string;
  optimize(input: OptimizeInput): Promise<{ optimized: string }>;
}
