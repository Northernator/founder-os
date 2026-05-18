/**
 * @founder-os/research-deep-core public entry — CLIENT-SAFE.
 *
 * Slice 1 of the Deep Research arc (see RESEARCH-DEEP-MODULE-SPEC.md):
 * contract types + sourced-sections emitter + paste-in parser. No I/O,
 * no node:* — the webview and Node side both import the same surface.
 *
 * The orchestrator (slice 4), providers (slice 2/3), and stage runners
 * (slice 5) all build on these schemas. The UI (slice 7) renders the
 * `ResearchPlan` directly and round-trips paste-in payloads through
 * `parsePastedDeepResearch`.
 */

// Types + schemas
export {
  ResearchChannelSchema,
  SourceTrustTierSchema,
  SourceSchema,
  ResearchAngleSchema,
  ResearchPrioritySchema,
  ResearchQuestionSchema,
  ChannelVerdictSchema,
  ResearchBriefingSectionSchema,
  ResearchBriefingSchema,
  ResearchTopicStatusSchema,
  ResearchPlanTopicSchema,
  ResearchPlanSchema,
  type ResearchChannel,
  type SourceTrustTier,
  type Source,
  type ResearchAngle,
  type ResearchPriority,
  type ResearchQuestion,
  type ChannelVerdict,
  type ResearchBriefingSection,
  type ResearchBriefing,
  type ResearchTopicStatus,
  type ResearchPlanTopic,
  type ResearchPlan,
  type CallLlm,
  type RequestPasteIn,
  type RequestPasteInResult,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
} from "./types.js";

// Constants
export {
  DEEP_RESEARCH_DIR_NAME,
  DEEP_RESEARCH_PLAN_FILE_NAME,
  DEEP_RESEARCH_CHECKPOINT_FILE_NAME,
  DEEP_RESEARCH_BRIEFINGS_DIR_NAME,
  DEEP_RESEARCH_SOURCES_DIR_NAME,
  DEEP_RESEARCH_SOURCES_INDEX_FILE_NAME,
  DEEP_RESEARCH_SOURCES_SNAPSHOTS_DIR_NAME,
  DEEP_RESEARCH_TRANSCRIPTS_DIR_NAME,
  DEFAULT_RESEARCH_CHANNELS,
  DEFAULT_RESEARCH_FALLBACKS,
  DEFAULT_STALE_AFTER_DAYS,
  STALE_AFTER_DAYS_BY_PREFIX,
  DEFAULT_MAX_COST_GBP_PER_TOPIC,
  DEFAULT_MAX_COST_GBP_PER_WARM_UP,
  DEFAULT_TOPIC_CONCURRENCY,
  DEFAULT_CHANNEL_CONCURRENCY_PER_TOPIC,
} from "./constants.js";

// Emitter
export {
  emitSourcedSectionsMarkdown,
  emitSectionSourcesBlock,
  formatSourceBulletLine,
  tallySourceTiers,
} from "./emitter.js";

// Parsers
export {
  parseResearchBriefing,
  safeParseResearchBriefing,
  parseResearchPlan,
  safeParseResearchPlan,
  parseResearchQuestion,
  safeParseResearchQuestion,
  parseSource,
  safeParseSource,
  parsePastedDeepResearch,
  type ParsePastedOpts,
} from "./parse.js";
