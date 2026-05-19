/**
 * OcrEngine port. Slice 3 ships only a noop implementation per
 * DREAM-VAULT-MODULE-SPEC §8 Q3 (typed stub first, real engine later).
 * A future slice can drop in a tesseract.js-backed engine without
 * touching any caller.
 */

export interface OcrEngineResult {
  text: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
}

export interface OcrEngine {
  id: string;
  recognise(buffer: Uint8Array): Promise<OcrEngineResult>;
}

/** Returns empty OCR text + a low-confidence flag. Used by tests + offline mode. */
export function createNoopOcrEngine(): OcrEngine {
  return {
    id: "noop",
    recognise: async () => ({
      text: "",
      confidence: "low",
      warnings: ["ocr engine not configured -- skipped"],
    }),
  };
}

/**
 * Convenience for tests: respond with a pre-baked transcription. The
 * runner integration tests (slice 8) use this to simulate OCR success
 * without booting the real tesseract worker.
 */
export function createStubOcrEngine(opts: {
  text: string;
  confidence?: "high" | "medium" | "low";
  warnings?: string[];
}): OcrEngine {
  return {
    id: "stub",
    recognise: async () => ({
      text: opts.text,
      confidence: opts.confidence ?? "medium",
      warnings: opts.warnings ?? [],
    }),
  };
}
