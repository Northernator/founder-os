/**
 * Slice 8 -- knowledge stage. Runs the knowledge-extractor per source
 * and aggregates ExtractedItem[] rows by sourceDocumentId.
 */
import { extractKnowledgeItems } from "@founder-os/knowledge-extractor";
import type { ExtractedItem, SourceType } from "@founder-os/vault-contract";
import type {
  VaultRunnerOpts,
  VaultSourceProcessing,
} from "./types.js";

export async function runKnowledgeStage(input: {
  perSource: VaultSourceProcessing[];
  /** sourceDocId -> suggested venture id from classify-stage. */
  suggestedProjectIds: Record<string, string | null>;
  callLlm?: VaultRunnerOpts["callLlm"];
  now: string;
}): Promise<{
  byId: Record<string, ExtractedItem[]>;
  warnings: string[];
}> {
  const byId: Record<string, ExtractedItem[]> = {};
  const warnings: string[] = [];

  for (const p of input.perSource) {
    if (p.extraction.kind === "failed" || p.extraction.kind === "skipped") {
      byId[p.source.id] = [];
      continue;
    }
    try {
      const result = await extractKnowledgeItems(
        {
          sourceDocumentId: p.source.id,
          projectId: input.suggestedProjectIds[p.source.id] ?? null,
          sourceType: p.source.sourceType as SourceType,
          title: p.source.originalName,
          markdown: p.markdown,
          ...(p.summary ? { summary: p.summary } : {}),
          now: input.now,
        },
        input.callLlm
      );
      byId[p.source.id] = result.items;
      p.knowledge = result;
      for (const w of result.warnings) {
        warnings.push(`source ${p.source.id}: knowledge: ${w}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      byId[p.source.id] = [];
      warnings.push(`source ${p.source.id}: knowledge threw: ${message}`);
    }
  }

  return { byId, warnings };
}
