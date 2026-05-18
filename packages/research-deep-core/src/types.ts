/**
 * Core contract types for the Deep Research module.
 *
 * See RESEARCH-DEEP-MODULE-SPEC.md §5 for the spec these schemas mirror.
 *
 * These types are CLIENT-SAFE — no node:* imports, no fs/spawn. The webview
 * imports this module to render the DeepResearchPanel and validate paste-in
 * payloads; Node-side code (providers, orchestrator, stage runners) imports
 * the same types to drive its work. Keep this file pure.
 *
 * Field naming mirrors the spec §5 verbatim; the schemas are the source of
 * truth and the orchestrator / UI both round-trip JSON through them.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Channels — the eight provider lanes the orchestrator can route through.
// Ordering mirrors the spec §6 tier ranking (lower index = preferred).
// ---------------------------------------------------------------------------

export const ResearchChannelSchema = z.enum([
  // tier_0 — subscription channels (founder already pays for these)
  "claude-sub",
  "gemini-sub",
  "chatgpt-sub",
  // tier_1 — programmatic API fallbacks
  "claude-api",
  "gemini-api",
  "chatgpt-api",
  // tier_2 — local sidecar (services/research-py via gpt-researcher)
  "research_py",
  // tier_3 — manual paste-in (never fails)
  "paste-in",
]);
export type ResearchChannel = z.infer<typeof ResearchChannelSchema>;

// ---------------------------------------------------------------------------
// Sources — provenance for every claim. Sourced sections, not sentences.
// ---------------------------------------------------------------------------

export const SourceTrustTierSchema = z.enum(["primary", "secondary", "tertiary"]);
export type SourceTrustTier = z.infer<typeof SourceTrustTierSchema>;

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  publisher: z.string().optional(),
  accessedAt: z.string().datetime(),
  retrievedBy: ResearchChannelSchema,
  // SHA1 of the canonicalised page text; points at
  // 00_research/deep/sources/snapshots/<sha1>.txt when snapshotting is on.
  excerptSha1: z.string().optional(),
  // primary  = .gov / official registry / regulator / first-party docs
  // secondary = reputable press, industry-association
  // tertiary  = blogs, forums, marketing pages (flagged but not excluded)
  trustTier: SourceTrustTierSchema.default("secondary"),
});
export type Source = z.infer<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// Questions — what the planner asks each worker to answer.
// ---------------------------------------------------------------------------

export const ResearchAngleSchema = z.enum([
  "market",
  "customer",
  "competitor",
  "regulatory",
  "technical",
  "financial",
  "risk",
]);
export type ResearchAngle = z.infer<typeof ResearchAngleSchema>;

export const ResearchPrioritySchema = z.enum(["must", "should", "nice"]);
export type ResearchPriority = z.infer<typeof ResearchPrioritySchema>;

export const ResearchQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  angle: ResearchAngleSchema,
  priority: ResearchPrioritySchema.default("should"),
});
export type ResearchQuestion = z.infer<typeof ResearchQuestionSchema>;

// ---------------------------------------------------------------------------
// Briefing sections — one heading + body + sources block, plus per-channel
// verdicts captured during the cross-reference pass.
// ---------------------------------------------------------------------------

export const ChannelVerdictSchema = z.object({
  agreed: z.boolean(),
  addedSources: z.array(z.string().url()).default([]),
  contradicted: z.string().optional(),
});
export type ChannelVerdict = z.infer<typeof ChannelVerdictSchema>;

export const ResearchBriefingSectionSchema = z.object({
  heading: z.string().min(1),
  // Markdown body. NO inline citations — every claim in this section is
  // bounded by the `sources` array, which the emitter renders as a
  // "**Sources consulted:**" block at the end of the section.
  body: z.string(),
  // URLs referenced by this section. Must each appear in the briefing's
  // top-level Source[] index too — the emitter cross-checks.
  sources: z.array(z.string().url()).default([]),
  // Per-channel agreement / disagreement, populated by the cross-referencer.
  // Optional because partial briefings (single-channel) skip cross-ref.
  llmVerdicts: z.record(ResearchChannelSchema, ChannelVerdictSchema).optional(),
});
export type ResearchBriefingSection = z.infer<typeof ResearchBriefingSectionSchema>;

// ---------------------------------------------------------------------------
// Final briefing — what gets written to 00_research/deep/briefings/<slug>.md
// (rendered) and <slug>.json (machine-readable).
// ---------------------------------------------------------------------------

export const ResearchBriefingSchema = z.object({
  ventureSlug: z.string().min(1),
  topicSlug: z.string().min(1),
  topicLabel: z.string().min(1),
  questions: z.array(ResearchQuestionSchema),
  sections: z.array(ResearchBriefingSectionSchema),
  sources: z.array(SourceSchema).default([]),
  channelsUsed: z.array(ResearchChannelSchema),
  // Channels that performed cross-reference + synthesis (usually a single
  // entry: ["claude-sub"]). Empty when only one channel responded.
  crossReferencedBy: z.array(ResearchChannelSchema).default([]),
  synthesisedBy: ResearchChannelSchema.optional(),
  // Free-text contradictions surfaced by the cross-referencer — shown in
  // the `Provenance & disagreements` footer.
  disagreements: z.array(z.string()).default([]),
  // Questions the workers couldn't answer; surfaced for re-run.
  unanswered: z.array(z.string()).default([]),
  generatedAt: z.string().datetime(),
  staleAfterDays: z.number().int().positive().default(30),
});
export type ResearchBriefing = z.infer<typeof ResearchBriefingSchema>;

// ---------------------------------------------------------------------------
// Plan — the topic-by-topic state machine the warm-up + UI both render.
// ---------------------------------------------------------------------------

export const ResearchTopicStatusSchema = z.enum([
  "pending",
  "running",
  "ready",
  "stale",
  "failed",
]);
export type ResearchTopicStatus = z.infer<typeof ResearchTopicStatusSchema>;

export const ResearchPlanTopicSchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  questions: z.array(ResearchQuestionSchema),
  status: ResearchTopicStatusSchema.default("pending"),
  // Stages that will read this topic — used to scope "stale" invalidation
  // so we don't churn re-researching unused topics.
  consumers: z.array(z.string()).default([]),
  lastRunAt: z.string().datetime().optional(),
  lastConsumedAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
});
export type ResearchPlanTopic = z.infer<typeof ResearchPlanTopicSchema>;

export const ResearchPlanSchema = z.object({
  ventureSlug: z.string().min(1),
  topics: z.array(ResearchPlanTopicSchema),
  // Ordered channel preference for this venture.
  channels: z.array(ResearchChannelSchema),
  generatedAt: z.string().datetime(),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

// ---------------------------------------------------------------------------
// Provider contract — what every channel (sub / API / paste-in / sidecar)
// implements. The orchestrator merges partial briefings from N providers
// into one final briefing via the cross-referencer + synthesiser.
// ---------------------------------------------------------------------------

/**
 * Minimal CallLlm contract — same shape as @founder-os/sales-agents'
 * `CallLlm` and the pipeline-runner's `SaasLlmCaller`. The host wires
 * whichever transport (subscription-CLI, API, or paste-in), the provider
 * doesn't care.
 */
export type CallLlm = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

/**
 * Callback supplied by the orchestrator for paste-in channels. Fires the
 * review-gate UI, blocks until the founder pastes the response (or
 * explicitly skips). The provider doesn't know about UI — it just awaits
 * the callback. Mirrors the gemini_flow paste-in pattern in the media arc.
 */
export type RequestPasteIn = (req: {
  channel: ResearchChannel;
  topicSlug: string;
  topicLabel: string;
  promptMarkdown: string;
}) => Promise<RequestPasteInResult>;

export type RequestPasteInResult =
  | { kind: "pasted"; markdown: string }
  | { kind: "skipped"; reason?: string };

/**
 * Partial briefing returned by a single provider. The synthesiser merges
 * partials across channels; the cross-referencer populates llmVerdicts.
 */
export interface ProviderPartial {
  /** Sections this provider could answer, in order. */
  sections: ResearchBriefingSection[];
  /** All sources referenced by this provider's sections. */
  sources: Source[];
  /** Questions this provider could not answer — surface for re-run. */
  unanswered: string[];
  /**
   * Raw transcript for audit (saved to
   * 00_research/deep/transcripts/<channel>/<topic>-<run>.json). Shape is
   * provider-specific; the orchestrator just persists it verbatim.
   */
  rawTranscript: unknown;
}

export interface ResearchProvider {
  name: ResearchChannel;
  /**
   * Cheap probe — does this channel work right now? Subscription channels
   * check binary presence / auth; API channels check key presence; paste-in
   * always returns true.
   */
  available(): Promise<boolean>;
  /**
   * Research one topic. The orchestrator runs this in parallel across 2–3
   * providers, then synthesises the partials. Errors throw — partial-but-
   * still-useful results return a `ProviderPartial` with `unanswered`
   * populated rather than throwing.
   */
  researchTopic(opts: ResearchTopicOpts): Promise<ProviderPartial>;
}

export interface ResearchTopicOpts {
  topic: { slug: string; label: string };
  questions: ResearchQuestion[];
  /**
   * ~2k chars of venture intake + brand brief, threaded into the worker
   * prompt so the answer is scoped to this venture rather than the
   * generic web.
   */
  ventureContext: string;
  /** ISO timestamp the provider should stamp into Source.accessedAt. */
  accessedAt?: string;
  /** Optional abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}
