/**
 * @founder-os/document-extractor public entry -- CLIENT-SAFE.
 *
 * Slice 3 of the DREAM_VAULT_MODULE arc. One entry per supported format,
 * each returning a zod-validated ExtractionResult. Pure formats
 * (markdown, text, HTML, CSV, JSON) extract in the renderer; PDF + DOCX
 * are port-based -- pass a noop extractor for offline preview, or the
 * real pdfjs-dist / mammoth implementation from "./node".
 */

export {
  type ExtractionResult,
  ExtractionResultSchema,
  DocumentExtractorError,
} from "./types";

export { extractMarkdown, type MarkdownInput } from "./pure/markdown";
export { extractText, type TextInput } from "./pure/text";
export { extractHtml, type HtmlInput } from "./pure/html";
export { extractCsv, type CsvInput } from "./pure/csv";
export { extractJson, type JsonInput } from "./pure/json";

export {
  type ExtractPdfInput,
  type PdfRawExtractionResult,
  type PdfTextExtractor,
  createNoopPdfTextExtractor,
  extractPdf,
} from "./pdf";

export {
  type DocxRawExtractionResult,
  type DocxTextExtractor,
  type ExtractDocxInput,
  createNoopDocxTextExtractor,
  extractDocx,
} from "./docx";
