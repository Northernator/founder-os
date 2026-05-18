/**
 * Synthesiser — merges N worker partials + cross-reference annotation
 * into the final ResearchBriefing. Spec §7 names Claude as the canonical
 * synthesiser; the caller injects any CallLlm.
 *
 * Two paths:
 *   - Multi-channel: ask Claude to merge sections (deduping overlapping
 *     headings, picking source-grounded prose) and return JSON
 *     {sections, unanswered}. We then assemble the full ResearchBriefing
 *     by joining the LLM's sections with the cross-reference verdicts +
 *     the merged source list pulled from the partials.
 *   - Single-channel (deterministic): no LLM call. We pass the lone
 *     partial's sections straight through and stamp `crossReferencedBy: []`
 *     + `synthesisedBy: undefined`. This is the spec's "deterministic
 *     fallback when only one channel is available".
 *
 * Either way the output is a zod-validated ResearchBriefing ready for
 * the emitter (research-deep-core/emitter).
 */

import {
  ResearchBriefingSchema,
  type CallLlm,
  type ChannelVerdict,
  type ProviderPartial,
  type ResearchBriefing,
  type ResearchBriefingSection,
  type ResearchChannel,
  type ResearchQuestion,
  type Source,
} from "@founder-os/research-deep-core";
import { z } from "zod";
import { SynthesiserError } from "./errors.js";
import {
  SYNTHESISER_SYSTEM_PROMPT,
  buildSynthesiserUserPrompt,
} from "./prompts.js";
import { parseLlmJson } from "./util.js";

const SynthesiserOutputSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        body: z.string(),
        sources: z.array(z.string().url()).default([]),
      }),
    )
    .min(1),
  unanswered: z.array(z.string()).default([]),
});

export interface SynthesiseInput {
  ventureSlug: string;
  topic: { slug: string; label: string };
  ventureContext: string;
  questions: ResearchQuestion[];
  partials: ReadonlyArray<{ channel: ResearchChannel; partial: ProviderPartial }>;
  /** Verdicts from cross-reference (optional — undefined for single-channel runs). */
  verdictsByHeading?: ReadonlyMap<
    string,
    Record<ResearchChannel, ChannelVerdict>
  >;
  /** Free-text disagreement lines from cross-reference. */
  disagreements?: ReadonlyArray<string>;
  /** Raw cross-ref JSON to thread back into the prompt — synth uses it. */
  crossReferenceJson?: unknown;
  /** Stamp into ResearchBriefing.generatedAt. */
  generatedAt: string;
  /** Channel that did cross-ref + synth — usually claude-sub. */
  synthesiserChannel?: ResearchChannel;
  staleAfterDays?: number;
}

export interface SynthesiseResult {
  briefing: ResearchBriefing;
  /** Raw LLM response when multi-channel; null for deterministic single-channel. */
  rawResponse: string | null;
}

/**
 * Produce the final ResearchBriefing. Branches on partial count: multi-
 * channel routes through Claude, single-channel returns deterministically.
 */
export async function synthesise(
  input: SynthesiseInput,
  opts: { callLlm: CallLlm },
): Promise<SynthesiseResult> {
  if (input.partials.length === 0) {
    throw new SynthesiserError(
      "no partials to synthesise — orchestrator should have raised AllWorkersFailedError",
    );
  }

  if (input.partials.length === 1) {
    return synthesiseDeterministic(input);
  }

  return synthesiseViaLlm(input, opts);
}

/**
 * Single-channel passthrough — no LLM call. The lone partial's sections
 * become the briefing's sections verbatim; sources are deduped by URL;
 * crossReferencedBy / synthesisedBy / disagreements are empty.
 */
function synthesiseDeterministic(input: SynthesiseInput): SynthesiseResult {
  const only = input.partials[0];
  if (!only) {
    throw new SynthesiserError("synthesiseDeterministic called with no partial");
  }
  const channel = only.channel;
  const sections: ResearchBriefingSection[] = only.partial.sections.map(
    (s) => ({
      heading: s.heading,
      body: s.body,
      sources: [...s.sources],
    }),
  );
  const sources = dedupSources(only.partial.sources);

  const briefing = ResearchBriefingSchema.parse({
    ventureSlug: input.ventureSlug,
    topicSlug: input.topic.slug,
    topicLabel: input.topic.label,
    questions: input.questions,
    sections,
    sources,
    channelsUsed: [channel],
    crossReferencedBy: [],
    disagreements: [],
    unanswered: only.partial.unanswered,
    generatedAt: input.generatedAt,
    ...(input.staleAfterDays != null
      ? { staleAfterDays: input.staleAfterDays }
      : {}),
  } satisfies Partial<ResearchBriefing> & Record<string, unknown>);

  return { briefing, rawResponse: null };
}

/**
 * Multi-channel synth — ask Claude to merge sections. We post-process the
 * LLM's section list: attach llmVerdicts from cross-reference, prune any
 * source URL the LLM hallucinated that no partial actually returned.
 */
async function synthesiseViaLlm(
  input: SynthesiseInput,
  opts: { callLlm: CallLlm },
): Promise<SynthesiseResult> {
  const user = buildSynthesiserUserPrompt({
    topic: input.topic,
    ventureContext: input.ventureContext,
    partials: input.partials,
    crossReferenceJson: input.crossReferenceJson ?? null,
  });

  let response: string;
  try {
    response = await opts.callLlm({
      system: SYNTHESISER_SYSTEM_PROMPT,
      user,
    });
  } catch (err) {
    throw new SynthesiserError("callLlm rejected", err);
  }
  if (!response || !response.trim()) {
    throw new SynthesiserError("empty response from callLlm");
  }

  let parsed: unknown;
  try {
    parsed = parseLlmJson(response);
  } catch (err) {
    throw new SynthesiserError("JSON parse failed", err);
  }

  let validated: z.infer<typeof SynthesiserOutputSchema>;
  try {
    validated = SynthesiserOutputSchema.parse(parsed);
  } catch (err) {
    throw new SynthesiserError("schema validation failed", err);
  }

  // Build the union of URLs the workers actually returned. Any URL the
  // synthesiser cites that isn't in this set is a hallucination — drop it
  // rather than carry a non-verifiable claim into the briefing.
  const knownUrls = new Set<string>();
  for (const { partial } of input.partials) {
    for (const s of partial.sources) knownUrls.add(s.url);
  }

  const sections: ResearchBriefingSection[] = validated.sections.map((s) => {
    const acceptedSources = s.sources.filter((u) => knownUrls.has(u));
    const verdicts = input.verdictsByHeading?.get(s.heading);
    return {
      heading: s.heading,
      body: s.body,
      sources: acceptedSources,
      ...(verdicts ? { llmVerdicts: verdicts } : {}),
    };
  });

  const allWorkerSources: Source[] = input.partials.flatMap((p) => p.partial.sources);
  const sources = dedupSources(allWorkerSources);

  const channelsUsed = input.partials.map((p) => p.channel);
  const synthChannel = input.synthesiserChannel ?? "claude-sub";

  const briefing = ResearchBriefingSchema.parse({
    ventureSlug: input.ventureSlug,
    topicSlug: input.topic.slug,
    topicLabel: input.topic.label,
    questions: input.questions,
    sections,
    sources,
    channelsUsed,
    crossReferencedBy: [synthChannel],
    synthesisedBy: synthChannel,
    disagreements: input.disagreements ? [...input.disagreements] : [],
    unanswered: validated.unanswered,
    generatedAt: input.generatedAt,
    ...(input.staleAfterDays != null
      ? { staleAfterDays: input.staleAfterDays }
      : {}),
  } satisfies Partial<ResearchBriefing> & Record<string, unknown>);

  return { briefing, rawResponse: response };
}

/**
 * Deduplicate sources by URL. When the same URL appears multiple times
 * across partials we keep the first occurrence's metadata (title /
 * publisher / accessedAt) — workers don't have a coherent way to vote on
 * which copy is "best", and the first one wins by call order, which is
 * deterministic given a stable provider list.
 */
function dedupSources(sources: ReadonlyArray<Source>): Source[] {
  const seen = new Map<string, Source>();
  for (const s of sources) {
    if (!seen.has(s.url)) seen.set(s.url, s);
  }
  return [...seen.values()];
}
