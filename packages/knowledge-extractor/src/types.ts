/**
 * Slice 6 -- shared types for the knowledge-extractor.
 *
 * CLIENT-SAFE -- no node:* imports, no filesystem, no provider SDKs.
 *
 * The extractor pulls atomic `ExtractedItem` rows out of an already-
 * extracted markdown blob. The LLM call is injected (subscription-first
 * via the existing streamChat dispatcher) so this package never sees a
 * provider SDK. When no callLlm is provided the deterministic fallback
 * runs unconditionally -- the no-LLM smoke path must always work.
 */
import {
  type Confidence,
  type ExtractedItem,
  type ExtractedItemType,
  ExtractedItemTypeSchema,
  type ReviewStatus,
  type SourceType,
} from "@founder-os/vault-contract";
import { z } from "zod";

/**
 * SaaS-style LLM caller. Same shape as `GoldenLlmCaller` so the
 * desktop's streamChat wrapper can be reused verbatim. Implementations
 * MUST throw on transport failure or empty output so the deterministic
 * fallback fires.
 */
export type KnowledgeCallLlm = (args: {
  system: string;
  user: string;
}) => Promise<string>;

/** Input the orchestrator hands to `extractKnowledgeItems`. */
export type KnowledgeExtractionInput = {
  /** Foreign key into vault_source_documents.id. */
  sourceDocumentId: string;
  /** Optional venture id when the project-classifier has already matched. */
  projectId?: string | null;
  /** Loose taxonomy bucket -- shapes the system prompt. */
  sourceType: SourceType;
  /** Display title used when the LLM doesn't supply one. */
  title: string;
  /** The extracted markdown content (already cleaned by document-extractor). */
  markdown: string;
  /** Optional summary the extractor produced; useful for the LLM prompt. */
  summary?: string;
  /** ISO timestamp threaded down for deterministic createdAt fields. */
  now: string;
  /** Soft cap on items returned. Default 12. */
  maxItems?: number;
  /** Soft cap on markdown chars passed to the LLM. Default 6000. */
  promptMarkdownLimit?: number;
};

export type KnowledgeExtractionResult = {
  items: ExtractedItem[];
  /** True iff the LLM returned at least one schema-valid item. */
  usedLlm: boolean;
  /** Parse / schema-drop diagnostics surfaced to the runner. */
  warnings: string[];
  /** Diagnostic notes the runner folds into its checkpoint. */
  notes: string[];
};

/**
 * Loose item shape emitted by the LLM. We accept partial rows and
 * coerce / default in `coerceLlmItem` so a single missing field doesn't
 * sink an otherwise-valid item.
 */
export const LlmItemSchema = z.object({
  type: ExtractedItemTypeSchema,
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});
export type LlmItem = z.infer<typeof LlmItemSchema>;

export class KnowledgeExtractorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KnowledgeExtractorError";
  }
}

/** Inputs the heuristic-only fallback receives. */
export type HeuristicInput = Pick<
  KnowledgeExtractionInput,
  "sourceDocumentId" | "projectId" | "sourceType" | "title" | "markdown" | "summary" | "now"
>;

/** Output of `coerceLlmItem` -- a fully-formed ExtractedItem. */
export type CoercedItem = {
  type: ExtractedItemType;
  title: string;
  content: string;
  confidence: Confidence;
  status: ReviewStatus;
};
