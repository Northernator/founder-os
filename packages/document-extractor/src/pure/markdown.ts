import { type ExtractionResult, ExtractionResultSchema } from "../types";
import { sanitiseMarkdown, summariseMarkdown } from "./helpers";

export interface MarkdownInput {
  /** Raw markdown text. */
  text: string;
}

export function extractMarkdown(input: MarkdownInput): ExtractionResult {
  const warnings: string[] = [];
  const cleaned = sanitiseMarkdown(input.text, warnings);
  return ExtractionResultSchema.parse({
    markdown: cleaned,
    summary: summariseMarkdown(cleaned),
    warnings,
    confidence: cleaned.trim() ? "high" : "low",
    extractionMethod: "markdown_native",
    needsReview: !cleaned.trim(),
  });
}
