/**
 * @founder-os/document-extractor/node -- Node-only entry point.
 *
 * Real-lib PDF + DOCX extractors. Banned from apps/founder-desktop/src
 * via the biome rule; renderer-side previews use the noop extractors
 * from the client-safe barrel.
 */

export { createPdfJsTextExtractor } from "./node/pdfjs-extractor.js";
export { createMammothTextExtractor } from "./node/mammoth-extractor.js";
