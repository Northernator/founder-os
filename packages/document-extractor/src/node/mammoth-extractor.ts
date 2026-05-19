/**
 * mammoth-backed DOCX text extractor. Uses mammoth.extractRawText so we
 * get text + (optionally) inline-image warnings without the HTML
 * post-processing pass.
 *
 * Thin wrapper -- the result envelope lives in src/docx.ts.
 */

import type { DocxRawExtractionResult, DocxTextExtractor } from "../docx";

export function createMammothTextExtractor(): DocxTextExtractor {
  return {
    id: "mammoth",
    extractText: async (buffer) => {
      const mammoth = await loadMammoth();
      const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
      const warnings = (result.messages ?? [])
        .filter((m) => m && (m.type === "warning" || m.type === "error"))
        .map((m) => m.message);
      return {
        text: result.value ?? "",
        warnings,
      } satisfies DocxRawExtractionResult;
    },
  };
}

interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<{
    value: string;
    messages?: Array<{ type?: string; message: string }>;
  }>;
}

async function loadMammoth(): Promise<MammothModule> {
  const mod = (await import("mammoth")) as unknown as
    | MammothModule
    | { default: MammothModule };
  if ("extractRawText" in mod) return mod;
  return mod.default;
}
