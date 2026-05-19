/**
 * Slice 6 -- prompt builders for the project-classifier.
 *
 * The LLM is asked to score each candidate venture against the source
 * document and return a JSON array. We force a stable confidence
 * vocabulary (high/medium/low) so the parser stays simple and the
 * deterministic-fallback semantics line up.
 */
import type { ClassifyDocumentInput, ProjectCandidate } from "./types.js";

export const CLASSIFIER_SYSTEM_PROMPT = `You are a project-routing assistant. Given a source document and a list of candidate ventures, return a JSON array of matches.

OUTPUT FORMAT (strict):
\`\`\`json
[
  {
    "projectId": "<one of the candidate projectIds, OR the literal string \\"unsorted\\">",
    "confidence": "high" | "medium" | "low",
    "reason": "one-sentence justification",
    "suggestedProjectName": "<optional, only when projectId === \\"unsorted\\" and you think a new venture should be created>"
  }
]
\`\`\`

RULES:
- Output ONLY the JSON array. No prose, no markdown fences, no trailing commentary.
- Score every candidate you believe is relevant. Skip candidates you would rate as no-match.
- If NO candidate is a plausible match, return a single entry with projectId="unsorted" and confidence="low".
- "high" = the document is clearly about this venture (matches name, keywords, or core summary).
- "medium" = the document is related but not centrally about this venture.
- "low" = a weak signal worth surfacing for human review.
- Never invent a projectId that is not in the candidate list (except the literal "unsorted").`;

function renderCandidate(c: ProjectCandidate): string {
  const summary = c.summary?.trim() ? ` -- ${c.summary.trim()}` : "";
  const keywords = c.keywords?.trim() ? ` [keywords: ${c.keywords.trim()}]` : "";
  return `- ${c.projectId} (${c.name}, slug=${c.slug})${summary}${keywords}`;
}

export function buildClassifierUserPrompt(input: ClassifyDocumentInput): string {
  const maxCandidates = input.maxCandidates ?? 12;
  const excerptLimit = input.promptExcerptLimit ?? 2000;
  const candidateList = input.candidates
    .slice(0, maxCandidates)
    .map(renderCandidate)
    .join("\n");
  const excerpt = (input.sourceExcerpt ?? "").trim();
  const truncated =
    excerpt.length > excerptLimit
      ? `${excerpt.slice(0, excerptLimit)}\n\n[truncated -- ${excerpt.length - excerptLimit} more chars]`
      : excerpt;
  const summaryLine = input.sourceSummary?.trim()
    ? `Source summary: ${input.sourceSummary.trim()}\n`
    : "";
  const typeLine = input.sourceType ? `Source type: ${input.sourceType}\n` : "";

  return `Source title: ${input.sourceTitle}
${typeLine}${summaryLine}
Candidate ventures:
${candidateList || "(none)"}

Source excerpt:
${truncated || "(no excerpt available)"}

Return the JSON array now.`;
}
