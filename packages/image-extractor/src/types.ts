import { ConfidenceSchema, ExtractionMethodSchema } from "@founder-os/vault-contract";
import { z } from "zod";

/** Pixel format detected by magic bytes -- "unknown" when no signature matches. */
export const ImagePixelFormatSchema = z.enum([
  "png",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "svg",
  "unknown",
]);
export type ImagePixelFormat = z.infer<typeof ImagePixelFormatSchema>;

export const ImageExtractionResultSchema = z.object({
  pixelFormat: ImagePixelFormatSchema,
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  /** OCR-extracted text, where an OcrEngine produced one. */
  ocrText: z.string().optional(),
  /** Free-text summary from the vision model, where callLlm was supplied. */
  visionSummary: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  confidence: ConfidenceSchema,
  extractionMethod: ExtractionMethodSchema,
  needsReview: z.boolean().default(false),
});
export type ImageExtractionResult = z.infer<typeof ImageExtractionResultSchema>;
