import { describe, expect, it } from "vitest";
import {
  createNoopDocxTextExtractor,
  createNoopPdfTextExtractor,
  extractDocx,
  extractPdf,
} from "../src/index";

const fakeBuffer = new Uint8Array([1, 2, 3]);

describe("extractPdf orchestration", () => {
  it("returns pdf_text on a text-bearing PDF", async () => {
    const extractor = createNoopPdfTextExtractor({
      text: "Page 1 contents.\n\nPage 2 contents.",
      pageCount: 2,
    });
    const result = await extractPdf({ buffer: fakeBuffer, extractor });
    expect(result.extractionMethod).toBe("pdf_text");
    expect(result.markdown).toContain("Page 1 contents.");
    expect(result.pageCount).toBe(2);
    expect(result.confidence).toBe("high");
  });

  it("routes empty-text PDFs to OCR via the sentinel extractionMethod", async () => {
    const extractor = createNoopPdfTextExtractor({ text: "", pageCount: 3 });
    const result = await extractPdf({ buffer: fakeBuffer, extractor });
    expect(result.extractionMethod).toBe("scanned_pdf_needs_ocr");
    expect(result.markdown).toBe("");
    expect(result.pageCount).toBe(3);
    expect(result.needsReview).toBe(true);
  });

  it("surfaces extractor warnings into the result", async () => {
    const extractor = createNoopPdfTextExtractor({
      text: "Page 1",
      pageCount: 1,
      warnings: ["page 2 had a corrupt xref"],
    });
    const result = await extractPdf({ buffer: fakeBuffer, extractor });
    expect(result.warnings).toContain("page 2 had a corrupt xref");
    expect(result.confidence).toBe("medium");
  });

  it("treats a thrown extractor as no-text + needs_review", async () => {
    const extractor = {
      id: "boom",
      extractText: async () => {
        throw new Error("pdf parser exploded");
      },
    };
    const result = await extractPdf({ buffer: fakeBuffer, extractor });
    expect(result.extractionMethod).toBe("pdf_no_text");
    expect(result.needsReview).toBe(true);
    expect(result.warnings.some((w) => /pdf parser exploded/.test(w))).toBe(true);
  });
});

describe("extractDocx orchestration", () => {
  it("happy path returns docx_mammoth + sanitised markdown", async () => {
    const extractor = createNoopDocxTextExtractor({
      text: "# Heading\n\nBody paragraph.\n",
    });
    const result = await extractDocx({ buffer: fakeBuffer, extractor });
    expect(result.extractionMethod).toBe("docx_mammoth");
    expect(result.markdown).toContain("# Heading");
    expect(result.confidence).toBe("high");
  });

  it("flags empty docx as needs_review", async () => {
    const extractor = createNoopDocxTextExtractor({ text: "" });
    const result = await extractDocx({ buffer: fakeBuffer, extractor });
    expect(result.needsReview).toBe(true);
    expect(result.confidence).toBe("low");
  });

  it("surfaces mammoth warnings", async () => {
    const extractor = createNoopDocxTextExtractor({
      text: "Body",
      warnings: ["image stripped: chart-1.png"],
    });
    const result = await extractDocx({ buffer: fakeBuffer, extractor });
    expect(result.warnings).toContain("image stripped: chart-1.png");
    expect(result.confidence).toBe("medium");
  });

  it("treats a thrown extractor as needs_review", async () => {
    const extractor = {
      id: "boom",
      extractText: async () => {
        throw new Error("zip read failed");
      },
    };
    const result = await extractDocx({ buffer: fakeBuffer, extractor });
    expect(result.needsReview).toBe(true);
    expect(result.warnings.some((w) => /zip read failed/.test(w))).toBe(true);
  });
});
