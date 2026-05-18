/**
 * Prompt blocks for the orchestrator's three Claude-driven phases:
 * planner, cross-referencer, synthesiser. Worker prompts live in
 * @founder-os/research-deep-providers/prompts so all worker channels
 * share the same instruction surface (cross-reference disagreements
 * reflect findings, not phrasing).
 *
 * These prompts ask Claude to emit JSON. The orchestrator parses and
 * zod-validates the responses; malformed output surfaces as a typed
 * error rather than silently corrupting the briefing.
 */

import type {
  ProviderPartial,
  ResearchChannel,
  ResearchQuestion,
} from "@founder-os/research-deep-core";

// ---------------------------------------------------------------------------
// Planner — produces ResearchQuestion[] for a single topic.
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `You are a research planner. \
The founder will name a topic; you decide what specific sub-questions deep \
research should answer to make a decision on that topic.

Rules:
- Return JSON only. No prose, no markdown fences, no preamble.
- 3 to 8 questions per topic. Bias toward 5 for general topics.
- Each question must be answerable by web research with citations.
- Tag each question by angle from this exact set: \
  market | customer | competitor | regulatory | technical | financial | risk.
- Tag each by priority from this exact set: must | should | nice. \
  Default to "should"; reserve "must" for the 1-3 questions a downstream \
  decision genuinely blocks on.
- Question IDs must be stable kebab-case slugs derived from the question \
  itself (e.g. "q-uk-saas-market-size-2026"). Unique within the topic.
- Avoid generic boilerplate ("what is X?"). Each question must be specific \
  enough that two researchers would produce overlapping source sets.

Output shape (JSON):
{
  "questions": [
    { "id": "q-...", "question": "...", "angle": "market", "priority": "should" }
  ]
}`;

export function buildPlannerUserPrompt(opts: {
  topic: { slug: string; label: string };
  ventureContext: string;
  /**
   * Optional seed questions from the stage runner. The planner refines /
   * supplements these rather than replacing them outright.
   */
  seedQuestions?: ReadonlyArray<ResearchQuestion>;
}): string {
  const { topic, ventureContext, seedQuestions } = opts;
  const seeds = seedQuestions && seedQuestions.length > 0
    ? `\n\n## Seed questions from the stage runner (refine, don't discard)\n\n` +
      seedQuestions
        .map((q, i) => `${i + 1}. (${q.angle}/${q.priority}) ${q.question}`)
        .join("\n")
    : "";

  return `# Topic to plan
Slug: ${topic.slug}
Label: ${topic.label}

## Venture context (verbatim from the founder's intake)

${ventureContext.trim()}${seeds}

## Output

Return the JSON object described in the system prompt. Nothing else.`;
}

// ---------------------------------------------------------------------------
// Cross-referencer — reads N worker partials side by side, flags
// agreements / contradictions / source-quality gaps. Output is annotation,
// not new prose.
// ---------------------------------------------------------------------------

export const CROSS_REFERENCE_SYSTEM_PROMPT = `You are a cross-reference \
analyst. The founder has dispatched the same topic to several research \
channels in parallel. Your job is to read their partials side-by-side and \
report agreements, contradictions, and source-quality gaps.

Rules:
- Return JSON only. No prose, no markdown fences, no preamble.
- For each section heading that appears in any partial, emit a verdict \
  entry per channel that touched it. \`agreed\` means the channel's \
  findings on this section are compatible with the others. \`contradicted\` \
  is a 1-2 sentence summary of the disagreement; omit if there is none.
- \`disagreements\` is a list of human-readable lines (1 sentence each) \
  that name the channels involved and describe what they disagreed on. \
  Empty array if all channels agree.
- Be terse. The founder reads this footer to decide what to trust.

Output shape (JSON):
{
  "verdicts": [
    {
      "heading": "Market size",
      "channel": "gemini-sub",
      "agreed": true,
      "contradicted": null
    }
  ],
  "disagreements": [
    "claude-sub and chatgpt-sub disagree on competitor B's pricing; gemini-sub did not address it."
  ]
}`;

export function buildCrossReferenceUserPrompt(opts: {
  topic: { slug: string; label: string };
  partials: ReadonlyArray<{ channel: ResearchChannel; partial: ProviderPartial }>;
}): string {
  const { topic, partials } = opts;
  const partialBlocks = partials
    .map(({ channel, partial }) => {
      const sectionBlocks = partial.sections
        .map((section) => {
          const sourceLines = section.sources.length > 0
            ? `\nSources: ${section.sources.join(", ")}`
            : "";
          return `### ${section.heading}\n${section.body.trim()}${sourceLines}`;
        })
        .join("\n\n");
      const unanswered = partial.unanswered.length > 0
        ? `\n\nUnanswered: ${partial.unanswered.join(" | ")}`
        : "";
      return `## Channel: ${channel}\n\n${sectionBlocks}${unanswered}`;
    })
    .join("\n\n---\n\n");

  return `# Topic: ${topic.label}

# Partials to cross-reference

${partialBlocks}

# Output

Return the JSON object described in the system prompt. Nothing else.`;
}

// ---------------------------------------------------------------------------
// Synthesiser — merges the N partials + cross-reference annotation into
// the final ResearchBriefing. Decides which sources land where, writes the
// final prose. Subscription-preferred routing favours Claude here.
// ---------------------------------------------------------------------------

export const SYNTHESISER_SYSTEM_PROMPT = `You are a research synthesiser. \
You will receive 2 or 3 channels' worth of partial findings on the same \
topic plus a cross-reference annotation. Produce the final briefing as \
JSON sections in the sourced-sections format.

Rules:
- Return JSON only. No prose, no markdown fences, no preamble.
- Merge overlapping sections from different channels into one. Prefer \
  prose that names the strongest available source.
- Each section's \`sources\` array lists ONLY the URLs that section's prose \
  actually relies on, drawn from the union of the partials' source lists.
- Do NOT use inline citations. Sources live at the section tail (the \
  emitter renders the "**Sources consulted:**" block).
- When channels disagree on a fact, side with the most primary source \
  (.gov / regulator / first-party docs) and reflect the disagreement in \
  the cross-reference annotation rather than the section body.
- If a section was flagged "contradicted" in the annotation, the prose \
  should acknowledge the disagreement and pick the primary-source answer.
- Carry forward unanswered questions verbatim into the top-level \
  \`unanswered\` array.
- 3 to 6 sections is typical. Do NOT invent sections that no channel touched.

Output shape (JSON):
{
  "sections": [
    {
      "heading": "Market size",
      "body": "Markdown paragraphs of plain prose. No inline citations.",
      "sources": ["https://...", "https://..."]
    }
  ],
  "unanswered": ["What is competitor B's exact pricing?"]
}`;

export function buildSynthesiserUserPrompt(opts: {
  topic: { slug: string; label: string };
  ventureContext: string;
  partials: ReadonlyArray<{ channel: ResearchChannel; partial: ProviderPartial }>;
  crossReferenceJson: unknown;
}): string {
  const { topic, ventureContext, partials, crossReferenceJson } = opts;
  const partialBlocks = partials
    .map(({ channel, partial }) => {
      const sections = partial.sections
        .map((section) => {
          const srcs = section.sources.length > 0
            ? `\nSources: ${section.sources.join(", ")}`
            : "";
          return `### ${section.heading}\n${section.body.trim()}${srcs}`;
        })
        .join("\n\n");
      return `## Channel: ${channel}\n\n${sections}`;
    })
    .join("\n\n---\n\n");

  return `# Topic: ${topic.label}

## Venture context

${ventureContext.trim()}

## Partials

${partialBlocks}

## Cross-reference annotation

${JSON.stringify(crossReferenceJson, null, 2)}

## Output

Return the JSON object described in the system prompt. Nothing else.`;
}
