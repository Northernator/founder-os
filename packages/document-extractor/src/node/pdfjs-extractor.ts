/**
 * pdfjs-dist-backed PDF text extractor. Uses the legacy Node build so we
 * can call it without a DOM. The desktop side's chat-attachments path
 * also reaches for pdfjs-dist (for OCR rasterisation), so this version
 * choice is consistent.
 *
 * The wrapper is intentionally thin -- the PDF orchestration (zero-text
 * fallback, warning aggregation) lives in src/pdf.ts.
 */

import type { PdfRawExtractionResult, PdfTextExtractor } from "../pdf";

export function createPdfJsTextExtractor(): PdfTextExtractor {
  return {
    id: "pdfjs-dist",
    extractText: async (buffer) => {
      const { getDocument } = await loadPdfjs();
      const warnings: string[] = [];
      const doc = await getDocument({
        data: buffer,
        // pdfjs prints noisy "Warning: ..." lines on stdout; we route
        // them through the warnings array so they survive into the
        // ExtractionResult.
        verbosity: 0,
        isEvalSupported: false,
      }).promise;

      const pageCount: number = doc.numPages;
      const pieces: string[] = [];
      for (let i = 1; i <= pageCount; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item: unknown) => {
            if (item && typeof item === "object" && "str" in item) {
              const v = (item as { str: unknown }).str;
              return typeof v === "string" ? v : "";
            }
            return "";
          })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) pieces.push(text);
      }
      const text = pieces.join("\n\n");
      return { text, pageCount, warnings } satisfies PdfRawExtractionResult;
    },
  };
}

interface PdfjsModule {
  getDocument: (params: {
    data: Uint8Array;
    verbosity?: number;
    isEvalSupported?: boolean;
  }) => {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
    }>;
  };
}

async function loadPdfjs(): Promise<PdfjsModule> {
  // Same import path the desktop side uses in chat-attachments.ts. In
  // Node 18+ + modern bundlers this resolves to the standard entry;
  // older runtimes can swap in pdfjs-dist/legacy/build/pdf.mjs.
  const mod = (await import("pdfjs-dist")) as unknown as PdfjsModule;
  return mod;
}
