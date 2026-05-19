/**
 * @founder-os/image-extractor/node -- reserved for future Node-only
 * code (e.g. a tesseract.js-backed OcrEngine, EXIF parsing via a
 * native lib). For slice 3 there is nothing Node-only here; the OCR
 * engine port + vision callLlm are deliberately injectable from the
 * client-safe barrel so a real implementation can be added without
 * forcing the renderer to import it.
 *
 * Re-exports the barrel so callers can choose this subpath when wiring
 * up a Node-only engine in a future slice.
 */

export * from "./index.js";
