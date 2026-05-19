/**
 * @founder-os/image-extractor public entry -- CLIENT-SAFE.
 *
 * Slice 3 of the DREAM_VAULT_MODULE arc. Pixel-format detection +
 * dimension reading happen inline (no native deps). OCR is gated behind
 * an OcrEngine port -- ship a noop now, swap in a real tesseract engine
 * later. Vision is gated behind a callLlm port (subscription-first via
 * the existing streamChat dispatcher; never imports a provider SDK).
 */

export {
  type ImageExtractionResult,
  ImageExtractionResultSchema,
  type ImagePixelFormat,
  ImagePixelFormatSchema,
} from "./types";

export { type ExtractImageInput, extractImage } from "./extract";

export {
  type OcrEngine,
  type OcrEngineResult,
  createNoopOcrEngine,
  createStubOcrEngine,
} from "./ocr";

export {
  type VisionCallLlm,
  type VisionCallLlmInput,
  type VisionResult,
  summariseImageWithLlm,
} from "./vision";

export { type ImageHeader, readImageHeader } from "./dimensions";
