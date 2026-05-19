/**
 * Slice 8 -- classify stage. Runs the project-classifier per source
 * and aggregates ProjectMatch[] rows by sourceDocumentId. Failed
 * sources from the extract stage are skipped (no markdown to classify).
 */
import { classifyDocument } from "@founder-os/project-classifier";
import type { ProjectMatch } from "@founder-os/vault-contract";
import type {
  VaultRunnerOpts,
  VaultSourceProcessing,
} from "./types.js";

export async function runClassifyStage(input: {
  perSource: VaultSourceProcessing[];
  candidates: VaultRunnerOpts["candidates"];
  callLlm?: VaultRunnerOpts["callLlm"];
  now: string;
  promptExcerptLimit?: number;
}): Promise<{
  byId: Record<string, ProjectMatch[]>;
  warnings: string[];
}> {
  const byId: Record<string, ProjectMatch[]> = {};
  const warnings: string[] = [];

  for (const p of input.perSource) {
    if (p.extraction.kind === "failed" || p.extraction.kind === "skipped") {
      byId[p.source.id] = [];
      continue;
    }
    try {
      const excerpt = p.markdown.slice(0, input.promptExcerptLimit ?? 2000);
      const result = await classifyDocument(
        {
          sourceDocumentId: p.source.id,
          sourceTitle: p.source.originalName,
          ...(p.summary ? { sourceSummary: p.summary } : {}),
          sourceExcerpt: excerpt,
          sourceType: p.source.sourceType,
          candidates: input.candidates,
          now: input.now,
        },
        input.callLlm
      );
      byId[p.source.id] = result.matches;
      // Hold the classifier result on the per-source row so the runner
      // can include it in VaultRunResult for the UI's review screen.
      p.classification = result;
      for (const w of result.warnings) {
        warnings.push(`source ${p.source.id}: classifier: ${w}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      byId[p.source.id] = [];
      warnings.push(`source ${p.source.id}: classifier threw: ${message}`);
    }
  }

  return { byId, warnings };
}

/**
 * Pick the highest-confidence match per source for the draft-note
 * suggested-slug field. Ties broken by candidate order (LLM order).
 * Returns null when no match has confidence >= "low".
 */
export function pickBestVentureSlug(
  matches: ProjectMatch[],
  candidates: VaultRunnerOpts["candidates"]
): string | null {
  const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
  let best: ProjectMatch | null = null;
  for (const m of matches) {
    if (m.projectId === null) continue;
    if (best === null || (order[m.confidence] ?? 0) > (order[best.confidence] ?? 0)) {
      best = m;
    }
  }
  if (!best || best.projectId === null) return null;
  const candidate = candidates.find((c) => c.projectId === best.projectId);
  return candidate?.slug ?? null;
}
