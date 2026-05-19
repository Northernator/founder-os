import { type ExtractionResult, ExtractionResultSchema } from "../types";
import { summariseMarkdown } from "./helpers";

export interface TextInput {
  text: string;
}

/**
 * Plain text is treated as a single fenced paragraph block. We do not
 * try to detect headings -- that's the LLM's job downstream.
 */
export function extractText(input: TextInput): ExtractionResult {
  const trimmed = input.text.replace(/\r\n/g, "\n").trim();
  const warnings: string[] = [];
  if (trimmed.length === 0) {
    warnings.push("empty text input");
  }
  if (containsBinaryNoise(trimmed)) {
    warnings.push("text contains non-printable bytes -- likely binary masquerading as text");
  }
  return ExtractionResultSchema.parse({
    markdown: trimmed,
    summary: summariseMarkdown(trimmed),
    warnings,
    confidence: trimmed && warnings.length === 0 ? "high" : trimmed ? "medium" : "low",
    extractionMethod: "text_native",
    needsReview: warnings.length > 0,
  });
}

function containsBinaryNoise(text: string): boolean {
  // Heuristic: > 5% non-printable / non-whitespace bytes flags a binary
  // file the user accidentally renamed .txt.
  if (text.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code >= 32 && code <= 126) continue;
    if (code >= 0x00a0) continue;
    bad += 1;
  }
  return bad / text.length > 0.05;
}
