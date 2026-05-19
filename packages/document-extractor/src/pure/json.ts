import { type ExtractionResult, ExtractionResultSchema } from "../types";

export interface JsonInput {
  text: string;
}

/**
 * JSON -> a fenced code block. The downstream LLM is better at reading
 * JSON than re-serialised "summary-ish" prose, so we keep it as-is with
 * pretty-printing if the input was minified.
 */
export function extractJson(input: JsonInput): ExtractionResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warnings.push(`JSON parse failed: ${message}`);
    return ExtractionResultSchema.parse({
      markdown: input.text,
      warnings,
      confidence: "low",
      extractionMethod: "json_native",
      needsReview: true,
    });
  }
  const pretty = JSON.stringify(parsed, null, 2);
  const md = `\`\`\`json\n${pretty}\n\`\`\``;
  return ExtractionResultSchema.parse({
    markdown: md,
    summary: summariseJson(parsed),
    warnings,
    confidence: "high",
    extractionMethod: "json_native",
  });
}

function summariseJson(value: unknown): string {
  if (Array.isArray(value)) return `JSON array (${value.length} items)`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `JSON object (${keys.length} top-level keys: ${keys.slice(0, 5).join(", ")}${
      keys.length > 5 ? "..." : ""
    })`;
  }
  if (typeof value === "string") return `JSON string (${value.length} chars)`;
  return `JSON ${typeof value}`;
}
