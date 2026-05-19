/**
 * DOCX extractor -- port-based. The real text extraction lives in
 * /node/mammoth-extractor.ts (mammoth.extractRawText). The pure-TS
 * orchestration handles the result envelope + degenerate cases.
 */

import { type ExtractionResult, ExtractionResultSchema } from "./types";
import { sanitiseMarkdown, summariseMarkdown } from "./pure/helpers";

export interface DocxRawExtractionResult {
  /** Markdown-ish text (mammoth returns raw or HTML; we accept either). */
  text: string;
  warnings: string[];
}

export interface DocxTextExtractor {
  id: string;
  extractText(buffer: Uint8Array): Promise<DocxRawExtractionResult>;
}

export interface ExtractDocxInput {
  buffer: Uint8Array;
  extractor: DocxTextExtractor;
}

export async function extractDocx(input: ExtractDocxInput): Promise<ExtractionResult> {
  const warnings: string[] = [];
  let raw: DocxRawExtractionResult;
  try {
    raw = await input.extractor.extractText(input.buffer);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warnings.push(`docx extractor "${input.extractor.id}" failed: ${message}`);
    return ExtractionResultSchema.parse({
      markdown: "",
      warnings,
      confidence: "low",
      extractionMethod: "docx_mammoth",
      needsReview: true,
    });
  }

  warnings.push(...raw.warnings);
  const cleaned = sanitiseMarkdown(raw.text, warnings);
  if (!cleaned.trim()) warnings.push("docx produced empty markdown");

  return ExtractionResultSchema.parse({
    markdown: cleaned,
    summary: summariseMarkdown(cleaned),
    warnings,
    confidence: cleaned.trim() ? (warnings.length === 0 ? "high" : "medium") : "low",
    extractionMethod: "docx_mammoth",
    needsReview: !cleaned.trim(),
  });
}

export function createNoopDocxTextExtractor(opts: {
  text?: string;
  warnings?: string[];
} = {}): DocxTextExtractor {
  return {
    id: "noop",
    extractText: async () => ({
      text: opts.text ?? "",
      warnings: opts.warnings ?? [],
    }),
  };
}
