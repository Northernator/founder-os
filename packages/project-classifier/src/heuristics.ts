/**
 * Slice 6 -- deterministic heuristics for the project-classifier.
 *
 * Fires when callLlm is undefined OR every LLM score is schema-invalid.
 * The strategy is intentionally shallow:
 *
 *   1. Build a token bag from the source title + summary + excerpt.
 *   2. For each candidate, score by overlap with its name + slug +
 *      keywords + summary.
 *   3. Map score thresholds onto Confidence:
 *        score >= 3 -> medium
 *        score >= 1 -> low
 *        score == 0 -> drop
 *   4. If every candidate scored zero, return a single "unsorted" row
 *      so the runner always has at least one match.
 *
 * The intent isn't to be smart -- it's to keep the no-LLM smoke path
 * green and give the human reviewer a sensible starting point.
 */
import type { Confidence } from "@founder-os/vault-contract";
import type { ClassifyDocumentInput, CoercedMatch, ProjectCandidate } from "./types.js";

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "have", "has",
  "are", "was", "were", "will", "shall", "would", "could", "should", "they",
  "their", "there", "here", "what", "when", "where", "which", "while", "about",
  "into", "more", "less", "than", "then", "some", "such", "very", "much", "many",
  "also", "just", "into", "over", "under", "between", "without", "within",
  "your", "you", "our", "his", "her", "him", "she", "its", "yet", "but", "not",
]);

function tokenise(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function candidateText(c: ProjectCandidate): string {
  return [c.name, c.slug.replace(/-/g, " "), c.summary ?? "", c.keywords ?? ""]
    .filter((s) => s && s.length > 0)
    .join(" ");
}

function scoreToConfidence(score: number): Confidence | null {
  if (score >= 3) return "medium";
  if (score >= 1) return "low";
  return null;
}

export function scoreCandidate(
  candidate: ProjectCandidate,
  sourceTokens: ReadonlySet<string>
): number {
  if (sourceTokens.size === 0) return 0;
  const candidateTokens = tokenise(candidateText(candidate));
  let score = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * Build the deterministic-fallback match list. The caller wraps each
 * CoercedMatch in a final ProjectMatch in `buildProjectMatches`.
 */
export function buildHeuristicMatches(input: ClassifyDocumentInput): CoercedMatch[] {
  const sourceText = [
    input.sourceTitle,
    input.sourceSummary ?? "",
    input.sourceExcerpt ?? "",
  ].join(" ");
  const sourceTokens = tokenise(sourceText);

  const scored: { candidate: ProjectCandidate; score: number; confidence: Confidence }[] = [];
  for (const candidate of input.candidates) {
    const score = scoreCandidate(candidate, sourceTokens);
    const confidence = scoreToConfidence(score);
    if (!confidence) continue;
    scored.push({ candidate, score, confidence });
  }

  if (scored.length === 0) {
    return [
      {
        projectId: null,
        confidence: "low",
        reason: "Deterministic fallback: no keyword overlap with any candidate venture.",
        status: "unsorted",
      },
    ];
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => ({
    projectId: s.candidate.projectId,
    confidence: s.confidence,
    reason: `Deterministic fallback: ${s.score} keyword overlap${s.score === 1 ? "" : "s"} with "${s.candidate.name}".`,
    status: "suggested",
  }));
}
