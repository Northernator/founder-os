/**
 * Slice 6 -- prompt builders for the knowledge-extractor.
 *
 * The system prompt locks the JSON output shape to the LlmItemSchema in
 * `./types.ts`. The user prompt carries a truncated markdown excerpt
 * plus a tiny one-shot example so the model anchors on the right
 * granularity (atomic, not multi-paragraph essays).
 */
import type { KnowledgeExtractionInput } from "./types.js";

export const KNOWLEDGE_SYSTEM_PROMPT = `You are an information extractor. Read the document and return a JSON array of atomic knowledge items.

OUTPUT FORMAT (strict):
\`\`\`json
[
  {
    "type": "decision" | "task" | "idea" | "prompt" | "summary" | "brand_reference" | "ui_reference" | "research_finding" | "code_snippet" | "todo" | "question" | "fact",
    "title": "short imperative title, < 80 chars",
    "content": "one-paragraph body capturing the item verbatim where possible",
    "confidence": "high" | "medium" | "low"
  }
]
\`\`\`

RULES:
- Output ONLY the JSON array. No preamble, no markdown fences, no trailing prose.
- Each item is ATOMIC -- one decision, one task, one quote, one prompt. Do not bundle.
- Prefer verbatim quotes in \`content\` over paraphrase.
- If the document has no extractable items, return [].
- "high" confidence means the item is explicit. "medium" means inferred but well-supported. "low" means a guess.
- Never invent facts the document does not contain.`;

export function buildKnowledgeUserPrompt(input: KnowledgeExtractionInput): string {
  const limit = input.promptMarkdownLimit ?? 6000;
  const md = input.markdown.length > limit
    ? `${input.markdown.slice(0, limit)}\n\n[truncated -- ${input.markdown.length - limit} more chars]`
    : input.markdown;
  const summaryLine = input.summary?.trim()
    ? `\nDocument summary: ${input.summary.trim()}`
    : "";
  return `Source title: ${input.title}
Source type: ${input.sourceType}${summaryLine}

Document content:
${md}

Return the JSON array now.`;
}
