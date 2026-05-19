/**
 * Slice 6 -- shared types for the project-classifier.
 *
 * CLIENT-SAFE -- no node:* imports, no provider SDKs, no DB. The runner
 * fetches the venture list from @founder-os/db and hands it in as
 * `ProjectCandidate[]` so this package stays portable / testable.
 */
import {
  type Confidence,
  ConfidenceSchema,
  type ProjectMatch,
  type ReviewStatus,
} from "@founder-os/vault-contract";
import { z } from "zod";

/**
 * Lightweight projection of a venture row for the classifier prompt.
 * The runner reads the full venture from the DB and projects only the
 * fields the LLM actually needs.
 */
export type ProjectCandidate = {
  /** Foreign key into ventures.id. */
  projectId: string;
  name: string;
  slug: string;
  /** Short summary -- e.g. venture.yaml `summary` field. Optional. */
  summary?: string;
  /** Optional comma-joined keywords / tags. */
  keywords?: string;
};

/** Same shape as KnowledgeCallLlm / GoldenLlmCaller. */
export type ClassifierCallLlm = (args: {
  system: string;
  user: string;
}) => Promise<string>;

/** Input the orchestrator hands to `classifyDocument`. */
export type ClassifyDocumentInput = {
  /** Foreign key into vault_source_documents.id. */
  sourceDocumentId: string;
  /** Display title of the source. */
  sourceTitle: string;
  /** Optional summary the extractor produced. */
  sourceSummary?: string;
  /** Optional excerpt of the markdown body. */
  sourceExcerpt?: string;
  /** Source taxonomy bucket -- useful prior for the prompt. */
  sourceType?: string;
  /** Candidate ventures the runner pulled from the DB. */
  candidates: ProjectCandidate[];
  /** ISO timestamp for stable createdAt/updatedAt. */
  now: string;
  /** Soft cap on candidate-list size passed to the LLM. Default 12. */
  maxCandidates?: number;
  /** Soft cap on excerpt chars passed to the LLM. Default 2000. */
  promptExcerptLimit?: number;
};

export type ClassifyDocumentResult = {
  matches: ProjectMatch[];
  /** True iff the LLM returned at least one schema-valid score. */
  usedLlm: boolean;
  warnings: string[];
  notes: string[];
};

/** Raw LLM scoring shape -- lenient parser, strict validator. */
export const LlmScoreSchema = z.object({
  /** Project id, OR the literal string "unsorted" for the "no match" bucket. */
  projectId: z.string().trim().min(1),
  confidence: ConfidenceSchema,
  reason: z.string().trim().min(1).optional(),
  suggestedProjectName: z.string().trim().min(1).optional(),
});
export type LlmScore = z.infer<typeof LlmScoreSchema>;

/** Internal coerced row -- one per classifier match before id assignment. */
export type CoercedMatch = {
  projectId: string | null;
  suggestedProjectName?: string;
  confidence: Confidence;
  reason?: string;
  status: ReviewStatus;
};

export class ProjectClassifierError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectClassifierError";
  }
}
