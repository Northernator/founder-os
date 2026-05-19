import { describe, expect, it } from "vitest";
import {
  createNoopOcrEngine,
  createStubOcrEngine,
  extractImage,
} from "../src/index";
import { makePngHeader } from "./fixtures";

describe("extractImage", () => {
  const PNG = makePngHeader(640, 480);

  it("flags needsReview when neither OCR nor vision is wired up", async () => {
    const result = await extractImage({ buffer: PNG });
    expect(result.pixelFormat).toBe("png");
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.needsReview).toBe(true);
    expect(result.warnings).toContain("ocr engine not supplied -- skipped");
    expect(result.warnings).toContain("vision callLlm not supplied -- skipped");
    expect(result.confidence).toBe("low");
  });

  it("uses the noop OCR engine without producing text", async () => {
    const result = await extractImage({ buffer: PNG, ocrEngine: createNoopOcrEngine() });
    expect(result.ocrText).toBeUndefined();
    expect(result.needsReview).toBe(true);
    expect(result.warnings.some((w) => /ocr engine not configured/.test(w))).toBe(true);
  });

  it("returns OCR text from a stub engine", async () => {
    const result = await extractImage({
      buffer: PNG,
      ocrEngine: createStubOcrEngine({ text: "hello from OCR" }),
    });
    expect(result.ocrText).toBe("hello from OCR");
    expect(result.extractionMethod).toBe("image_ocr");
    expect(result.needsReview).toBe(false);
    expect(result.confidence).toBe("medium");
  });

  it("invokes callLlm + returns a vision summary", async () => {
    const result = await extractImage({
      buffer: PNG,
      callLlm: async ({ imageMimeType }) => {
        expect(imageMimeType).toBe("image/png");
        return "  A blue square on a white background.  ";
      },
    });
    expect(result.visionSummary).toBe("A blue square on a white background.");
    expect(result.extractionMethod).toBe("image_vision");
    expect(result.confidence).toBe("medium");
    expect(result.needsReview).toBe(false);
  });

  it("returns high confidence when both OCR and vision succeed", async () => {
    const result = await extractImage({
      buffer: PNG,
      ocrEngine: createStubOcrEngine({ text: "OCR text" }),
      callLlm: async () => "Vision summary",
    });
    expect(result.confidence).toBe("high");
  });

  it("catches a thrown OcrEngine -- result still includes vision/format info", async () => {
    const result = await extractImage({
      buffer: PNG,
      ocrEngine: {
        id: "boom",
        recognise: async () => {
          throw new Error("ocr worker crashed");
        },
      },
      callLlm: async () => "fallback vision summary",
    });
    expect(result.visionSummary).toBe("fallback vision summary");
    expect(result.warnings.some((w) => /ocr worker crashed/.test(w))).toBe(true);
  });

  it("catches a thrown callLlm via the vision wrapper", async () => {
    const result = await extractImage({
      buffer: PNG,
      callLlm: async () => {
        throw new Error("network down");
      },
    });
    expect(result.visionSummary).toBeUndefined();
    expect(result.warnings.some((w) => /vision model call failed/.test(w))).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it("flags unknown pixel format as a warning", async () => {
    const result = await extractImage({
      buffer: new TextEncoder().encode("not an image"),
      ocrEngine: createStubOcrEngine({ text: "OCR somehow" }),
    });
    expect(result.pixelFormat).toBe("unknown");
    expect(result.warnings).toContain("image header did not match a known format");
  });
});
