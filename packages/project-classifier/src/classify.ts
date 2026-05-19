/**
 * Slice 6 -- main entry point for the project-classifier.
 *
 * `classifyDocument` mirrors the dual-mode shape of the
 * knowledge-extractor:
 *   - callLlm provided -> ask the model for a JSON array, drop rows
 *     that fail LlmScoreSchema, coerce the rest.
 *   - callLlm absent OR LLM call fails OR every score is invalid
 *     -> fall back to deterministic keyword-overlap heuristics so the
 *        offline smoke path always produces at least one match.
 *
 * The classifier never imports a provider SDK -- callLlm is the
 * boundary, and `mode: "subscription"` routing happens upstream in the
 * desktop's streamChat dispatcher.
 */
import type { ProjectMatch } from "@founder-os/vault-contract";
import { buildHeuristicMatches } from "./heuristics.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from "./prompt.js";
import {
  type ClassifierCallLlm,
  type ClassifyDocumentInput,
  type ClassifyDocumentResult,
  type CoercedMatch,
  LlmScoreSchema,
} from "./types.js";

/**
 * Reuse the bracket-walker from knowledge-extractor without coupling
 * packages: small parsers are cheap to copy. Returns null when the
 * response contains no parseable JSON array.
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)```\s*$/);
  const body = fenceMatch?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          return Array.isArray(parsed) ? (parsed as unknown[]) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Coerce a raw LLM array into validated CoercedMatch rows. Rows that
 * fail LlmScoreSchema OR that reference an unknown projectId (other
 * than the literal "unsorted") are dropped with a warning.
 */
export function coerceLlmScores(
  raw: unknown[],
  validProjectIds: ReadonlySet<string>,
  warnings: string[]
): CoercedMatch[] {
  const out: CoercedMatch[] = [];
  let droppedSchema = 0;
  let droppedUnknownId = 0;
  raw.forEach((entry, idx) => {
    const parsed = LlmScoreSchema.safeParse(entry);
    if (!parsed.success) {
      droppedSchema += 1;
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") || "(root)";
      warnings.push(`score #${idx}: schema-invalid (${path}: ${issue?.message ?? "?"})`);
      return;
    }
    const score = parsed.data;
    const isUnsorted = score.projectId === "unsorted";
    if (!isUnsorted && !validProjectIds.has(score.projectId)) {
      droppedUnknownId += 1;
      warnings.push(
        `score #${idx}: unknown projectId="${score.projectId}" (not in candidate list)`
      );
      return;
    }
    out.push({
      projectId: isUnsorted ? null : score.projectId,
      ...(score.suggestedProjectName && isUnsorted
        ? { suggestedProjectName: score.suggestedProjectName }
        : {}),
      confidence: score.confidence,
      ...(score.reason ? { reason: score.reason } : {}),
      status: isUnsorted ? "unsorted" : "suggested",
    });
  });
  if (droppedSchema > 0) {
    warnings.unshift(`dropped ${droppedSchema} schema-invalid score${droppedSchema === 1 ? "" : "s"}`);
  }
  if (droppedUnknownId > 0) {
    warnings.unshift(
      `dropped ${droppedUnknownId} score${droppedUnknownId === 1 ? "" : "s"} pointing at unknown projectIds`
    );
  }
  return out;
}

/** Stable per-source match id: `<sourceDocumentId>:<index>`. */
export function buildMatchId(sourceDocumentId: string, index: number): string {
  return `${sourceDocumentId}:match:${index}`;
}

function coercedToProjectMatch(
  match: CoercedMatch,
  sourceDocumentId: string,
  now: string,
  index: number
): ProjectMatch {
  return {
    id: buildMatchId(sourceDocumentId, index),
    sourceDocumentId,
    projectId: match.projectId,
    ...(match.suggestedProjectName ? { suggestedProjectName: match.suggestedProjectName } : {}),
    confidence: match.confidence,
    ...(match.reason ? { reason: match.reason } : {}),
    status: match.status,
    createdAt: now,
    updatedAt: now,
  };
}

export async function classifyDocument(
  input: ClassifyDocumentInput,
  callLlm?: ClassifierCallLlm
): Promise<ClassifyDocumentResult> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const validIds = new Set(input.candidates.map((c) => c.projectId));

  let llmMatches: CoercedMatch[] = [];
  let usedLlm = false;
  if (callLlm) {
    try {
      const raw = await callLlm({
        system: CLASSIFIER_SYSTEM_PROMPT,
        user: buildClassifierUserPrompt(input),
      });
      const arr = extractJsonArray(raw);
      if (arr === null) {
        warnings.push("LLM response did not contain a JSON array");
      } else if (arr.length === 0) {
        notes.push("LLM returned an empty array");
      } else {
        llmMatches = coerceLlmScores(arr, validIds, warnings);
        if (llmMatches.length > 0) usedLlm = true;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      warnings.push(`LLM call failed: ${m}`);
    }
  }

  const coerced: CoercedMatch[] =
    llmMatches.length > 0 ? llmMatches : buildHeuristicMatches(input);
  if (llmMatches.length === 0 && callLlm) {
    notes.push("LLM path produced no valid matches -- using deterministic fallback");
  }

  const matches = coerced.map((m, idx) =>
    coercedToProjectMatch(m, input.sourceDocumentId, input.now, idx)
  );

  return { matches, usedLlm, warnings, notes };
}
