/**
 * Constants for the Deep Research module.
 *
 * Spec references: RESEARCH-DEEP-MODULE-SPEC.md §4 (folder layout), §11
 * (caching / freshness), §12 (cost defaults).
 */

import type { ResearchChannel } from "./types.js";

// ---------------------------------------------------------------------------
// Vault layout — sub-paths under <ventureRoot>/00_research/deep/
// 00_research/ itself is owned by @founder-os/workspace-core/paths.ts;
// these constants describe what the orchestrator writes inside `deep/`.
// ---------------------------------------------------------------------------

export const DEEP_RESEARCH_DIR_NAME = "deep";
export const DEEP_RESEARCH_PLAN_FILE_NAME = "plan.json";
export const DEEP_RESEARCH_CHECKPOINT_FILE_NAME = "deep-research-checkpoint.json";
export const DEEP_RESEARCH_BRIEFINGS_DIR_NAME = "briefings";
export const DEEP_RESEARCH_SOURCES_DIR_NAME = "sources";
export const DEEP_RESEARCH_SOURCES_INDEX_FILE_NAME = "index.json";
export const DEEP_RESEARCH_SOURCES_SNAPSHOTS_DIR_NAME = "snapshots";
export const DEEP_RESEARCH_TRANSCRIPTS_DIR_NAME = "transcripts";

// ---------------------------------------------------------------------------
// Default channel ordering — preferred first. Used when the venture's
// venture.yaml doesn't override `research.deep.channels`.
// ---------------------------------------------------------------------------

export const DEFAULT_RESEARCH_CHANNELS: readonly ResearchChannel[] = [
  "claude-sub",
  "gemini-sub",
  "chatgpt-sub",
];

export const DEFAULT_RESEARCH_FALLBACKS: readonly ResearchChannel[] = [
  "claude-api",
  "gemini-api",
  "research_py",
  "paste-in",
];

// ---------------------------------------------------------------------------
// Freshness defaults — spec §11. Stale topics are flagged for re-run.
// ---------------------------------------------------------------------------

export const DEFAULT_STALE_AFTER_DAYS = 30;

/**
 * Per-angle overrides — regulatory / pricing facts go stale fast; technical
 * baselines (frameworks, language standards) age more slowly. Indexed by
 * topic-slug *prefix* rather than the angle enum so a topic can opt into a
 * shorter window without forcing a new angle.
 */
export const STALE_AFTER_DAYS_BY_PREFIX: Record<string, number> = {
  "regulatory-": 7,
  "compliance-": 7,
  "pricing-": 7,
  "tax-": 7,
  "framework-": 90,
  "technical-baseline-": 90,
  "platform-": 60,
};

// ---------------------------------------------------------------------------
// Cost defaults — spec §12. Hard caps per venture; orchestrator drops
// channels rather than overrun these. GBP because the venture's finance
// cap is GBP-denominated.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_COST_GBP_PER_TOPIC = 0.5;
export const DEFAULT_MAX_COST_GBP_PER_WARM_UP = 8.0;

// ---------------------------------------------------------------------------
// Concurrency caps — three channels × ~2 topics in parallel is conservative
// but stays under subscription rate limits for Claude / Gemini. Tunable in
// venture.yaml.
// ---------------------------------------------------------------------------

export const DEFAULT_TOPIC_CONCURRENCY = 2;
export const DEFAULT_CHANNEL_CONCURRENCY_PER_TOPIC = 3;
