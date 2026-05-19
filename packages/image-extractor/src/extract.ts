/**
 * extractImage -- the public orchestration entry.
 *
 * The pipeline:
 *   1. Read pixel format + dimensions from the buffer head.
 *   2. If an OcrEngine is provided, run it.
 *   3. If a VisionCallLlm is provided, ask it for a summary.
 *   4. Return ImageExtractionResult + needsReview = (no OCR text AND no
 *      vision summary).
 */

import type { OcrEngine } from "./ocr";
import { readImageHeader } from "./dimensions";
import {
  type ImageExtractionResult,
  ImageExtractionResultSchema,
} from "./types";
import { type VisionCallLlm, summariseImageWithLlm } from "./vision";

export interface ExtractImageInput {
  buffer: Uint8Array;
  mimeType?: string;
  ocrEngine?: OcrEngine;
  callLlm?: VisionCallLlm;
  /** Override the default vision prompt. */
  visionPrompt?: string;
}

export async function extractImage(input: ExtractImageInput): Promise<ImageExtractionResult> {
  const header = readImageHeader(input.buffer);
  const warnings: string[] = [];
  if (header.pixelFormat === "unknown") {
    warnings.push("image header did not match a known format");
  }

  let ocrText: string | undefined;
  if (input.ocrEngine) {
    try {
      const ocr = await input.ocrEngine.recognise(input.buffer);
      warnings.push(...ocr.warnings);
      if (ocr.text.trim()) ocrText = ocr.text.trim();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      warnings.push(`ocr engine "${input.ocrEngine.id}" failed: ${message}`);
    }
  } else {
    warnings.push("ocr engine not supplied -- skipped");
  }

  let visionSummary: string | undefined;
  if (input.callLlm) {
    const mime = input.mimeType ?? mimeForFormat(header.pixelFormat);
    const vision = await summariseImageWithLlm({
      buffer: input.buffer,
      mimeType: mime,
      callLlm: input.callLlm,
      prompt: input.visionPrompt,
    });
    warnings.push(...vision.warnings);
    if (vision.summary) visionSummary = vision.summary;
  } else {
    warnings.push("vision callLlm not supplied -- skipped");
  }

  const hasContent = Boolean(ocrText) || Boolean(visionSummary);
  const extractionMethod = visionSummary ? "image_vision" : "image_ocr";
  const confidence: "high" | "medium" | "low" = hasContent
    ? visionSummary && ocrText
      ? "high"
      : "medium"
    : "low";

  return ImageExtractionResultSchema.parse({
    pixelFormat: header.pixelFormat,
    width: header.width,
    height: header.height,
    ocrText,
    visionSummary,
    warnings,
    confidence,
    extractionMethod,
    needsReview: !hasContent,
  });
}

function mimeForFormat(format: string): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "tiff":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
