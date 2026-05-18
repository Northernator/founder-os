/**
 * Shared worker-prompt builder.
 *
 * Every worker channel (claude-sub / gemini-sub / chatgpt-sub / paste-in)
 * asks its LLM to answer the same prompt and emit the same markdown
 * format. Centralising the prompt here means:
 *
 *   - The output format is identical across channels, so the same paste-in
 *     parser (`parsePastedDeepResearch` from research-deep-core) can
 *     ingest every provider's response.
 *   - Cross-reference disagreements reflect genuine differences in
 *     findings — not differences in prompt wording.
 *   - The orchestrator can swap one channel for another without recoding
 *     anything except `available()` / I/O.
 */

import type { ResearchQuestion } from "@founder-os/research-deep-core";

/**
 * System prompt — the persona + ground rules. Stays stable across
 * channels and runs. Updating this is a behaviour change with cross-
 * channel cross-reference impact; treat as schema.
 */
export const RESEARCH_WORKER_SYSTEM_PROMPT = `You are a deep research analyst. \
Your job is to research the topic the user names, using web search to find current sources, \
and return findings as sourced markdown.

Rules:
- Use the web. Do NOT answer from training data alone — the founder needs current sources.
- Cite EVERY claim by appending a "**Sources consulted:**" block at the end of each section. \
  Do NOT use inline citations like [1] or footnote markers. Sources live at the section's tail.
- Each source bullet MUST include the URL. Prefer the format: \
  "- <Title>, <publisher>, accessed <YYYY-MM-DD> — <url>".
- Prefer primary sources (.gov, regulators, first-party docs, company filings). \
  When using secondary sources (reputable press, industry associations), favour ones with \
  publication dates ≤ 12 months old.
- Produce one H2 heading (\`## ...\`) per major finding. 3–6 sections is typical.
- Each section body should be 1–4 short paragraphs of plain prose. No bullet lists inside the \
  body unless the topic genuinely calls for them (e.g. enumerating requirements).
- If you cannot answer a question with web-sourced evidence, end your reply with a \
  "## Unanswered" section listing the question text verbatim. Do NOT fabricate.
- Output ONLY the markdown. No preamble, no "Here is my research:", no closing summary.`;

/**
 * Builds the user-side prompt for one topic. Threads the venture context
 * in so the answer is scoped to this founder's situation.
 */
export function buildWorkerUserPrompt(opts: {
  topic: { slug: string; label: string };
  questions: ReadonlyArray<ResearchQuestion>;
  ventureContext: string;
  accessedAt: string;
}): string {
  const { topic, questions, ventureContext, accessedAt } = opts;

  const questionLines = questions
    .map((q, i) => `${i + 1}. (${q.angle}/${q.priority}) ${q.question}`)
    .join("\n");

  return `# Topic: ${topic.label}

## Venture context (verbatim from the founder's intake)

${ventureContext.trim()}

## Questions to answer

${questionLines}

## Output requirements

- Today's date for "accessed" stamps: ${accessedAt.slice(0, 10)}.
- Produce sourced-sections markdown per the system prompt's rules.
- A "## Provenance" or "## Notes" section is optional but a "## Unanswered" section is REQUIRED \
  if any of the numbered questions cannot be sourced.
- Do NOT echo this prompt back. Begin your reply with the first \`## ...\` heading.`;
}

/**
 * Build the markdown a paste-in channel hands to the founder. This is what
 * the UI shows in the review gate; the founder copies it, runs it in
 * ChatGPT / Gemini / wherever, and pastes the response back.
 */
export function buildPasteInPromptMarkdown(opts: {
  topic: { slug: string; label: string };
  questions: ReadonlyArray<ResearchQuestion>;
  ventureContext: string;
  accessedAt: string;
  channelHint?: string;
}): string {
  const inner = buildWorkerUserPrompt(opts);
  const hint = opts.channelHint
    ? `\n\n> Paste this into ${opts.channelHint}, run deep research / browsing, then paste the entire response back.\n`
    : "\n\n> Paste this into your LLM, run deep research / browsing, then paste the entire response back.\n";
  return `${RESEARCH_WORKER_SYSTEM_PROMPT}${hint}\n---\n\n${inner}\n`;
}
