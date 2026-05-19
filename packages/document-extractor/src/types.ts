/**
 * Shared envelope every extractor returns. The runner (slice 8) writes
 * this directly to a vault_source_extractions row.
 */

import {
  ConfidenceSchema,
  ExtractionMethodSchema,
} from "@founder-os/vault-contract";
import { z } from "zod";

export const ExtractionResultSchema = z.object({
  markdown: z.string(),
  summary: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  confidence: ConfidenceSchema,
  extractionMethod: ExtractionMethodSchema,
  /** Detected ISO 639-1 language code, where known. */
  language: z.string().optional(),
  /** PDF only -- page count. */
  pageCount: z.number().int().nonnegative().optional(),
  /**
   * True when the document needs human review before downstream stages
   * trust the markdown. Set on degenerate inputs (empty PDFs, encrypted
   * docs, partially-parsed HTML).
   */
  needsReview: z.boolean().default(false),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export class DocumentExtractorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DocumentExtractorError";
  }
}
