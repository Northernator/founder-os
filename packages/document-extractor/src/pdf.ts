/**
 * PDF extractor -- port-based. The real text extraction lives in
 * /node/pdfjs-extractor.ts; here we own the "no text -> needs OCR"
 * branching + the result envelope.
 *
 * When the underlying extractor reports zero extractable text we return
 * `extractionMethod: "scanned_pdf_needs_ocr"` -- the runner then re-routes
 * the source through @founder-os/image-extractor's OCR path (slice 3).
 */

import { type ExtractionResult, ExtractionResultSchema } from "./types";

export interface PdfRawExtractionResult {
  /** Concatenated text from every page. May be empty for scanned PDFs. */
  text: string;
  pageCount: number;
  warnings: string[];
}

export interface PdfTextExtractor {
  id: string;
  extractText(buffer: Uint8Array): Promise<PdfRawExtractionResult>;
}

export interface ExtractPdfInput {
  buffer: Uint8Array;
  extractor: PdfTextExtractor;
}

export async function extractPdf(input: ExtractPdfInput): Promise<ExtractionResult> {
  const warnings: string[] = [];
  let raw: PdfRawExtractionResult;
  try {
    raw = await input.extractor.extractText(input.buffer);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warnings.push(`pdf extractor "${input.extractor.id}" failed: ${message}`);
    return ExtractionResultSchema.parse({
      markdown: "",
      warnings,
      confidence: "low",
      extractionMethod: "pdf_no_text",
      needsReview: true,
    });
  }

  warnings.push(...raw.warnings);

  if (!raw.text.trim()) {
    warnings.push("pdf produced no extractable text -- routing to OCR");
    return ExtractionResultSchema.parse({
      markdown: "",
      warnings,
      confidence: "low",
      extractionMethod: "scanned_pdf_needs_ocr",
      pageCount: raw.pageCount,
      needsReview: true,
    });
  }

  return ExtractionResultSchema.parse({
    markdown: raw.text.trim(),
    summary: undefined,
    warnings,
    confidence: warnings.length === 0 ? "high" : "medium",
    extractionMethod: "pdf_text",
    pageCount: raw.pageCount,
  });
}

/** Deterministic noop extractor -- used by tests + offline preview UI. */
export function createNoopPdfTextExtractor(opts: {
  text?: string;
  pageCount?: number;
  warnings?: string[];
} = {}): PdfTextExtractor {
  return {
    id: "noop",
    extractText: async () => ({
      text: opts.text ?? "",
      pageCount: opts.pageCount ?? 0,
      warnings: opts.warnings ?? [],
    }),
  };
}
