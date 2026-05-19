/**
 * Slice 6 -- deterministic heuristics for the knowledge-extractor.
 *
 * Fires when callLlm is undefined OR when the LLM call fails / returns
 * nothing valid. The no-LLM smoke path must stay green so the offline
 * desktop install always produces at least one item per source.
 *
 * The heuristics are intentionally shallow:
 *   - one `summary` item using the supplied summary or the first
 *     paragraph of the markdown,
 *   - one `decision` / `task` / `prompt` item per bullet that matches
 *     a clear keyword on the first line ("decided", "TODO", "Prompt:").
 * Anything more elaborate is the LLM's job.
 */
import type {
  Confidence,
  ExtractedItem,
  ExtractedItemType,
  SourceType,
} from "@founder-os/vault-contract";
import type { CoercedItem, HeuristicInput } from "./types.js";

const MAX_HEURISTIC_ITEMS = 6;

const KEYWORD_RULES: ReadonlyArray<{
  pattern: RegExp;
  type: ExtractedItemType;
}> = [
  { pattern: /^(decision|decided|we (will|won't|are going to|chose|picked))\b/i, type: "decision" },
  { pattern: /^(todo|to do|to-do|action item|next step|task)\s*[:\-]/i, type: "task" },
  { pattern: /^(prompt|system prompt|user prompt)\s*[:\-]/i, type: "prompt" },
  { pattern: /^(idea|hypothesis|what if)\s*[:\-]?/i, type: "idea" },
  { pattern: /^(question|q)\s*[:\-]/i, type: "question" },
  { pattern: /^(brand|colour|color palette|font|logo)\s*[:\-]/i, type: "brand_reference" },
  { pattern: /^(ui|screen|wireframe|component)\s*[:\-]/i, type: "ui_reference" },
];

function defaultTypeForSource(sourceType: SourceType): ExtractedItemType {
  switch (sourceType) {
    case "chat":
    case "transcript":
      return "summary";
    case "image":
      return "ui_reference";
    case "code":
      return "code_snippet";
    case "structured":
    case "spreadsheet":
      return "fact";
    default:
      return "summary";
  }
}

function firstParagraph(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return "";
  const stop = trimmed.search(/\n\s*\n/);
  return stop === -1 ? trimmed : trimmed.slice(0, stop);
}

/** Pull the first ~80 chars of a line as a title. */
function lineToTitle(line: string): string {
  const stripped = line.replace(/^[-*+>\s]+/, "").trim();
  if (stripped.length <= 80) return stripped;
  return `${stripped.slice(0, 77).trim()}...`;
}

function extractBullets(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    if (out.length >= MAX_HEURISTIC_ITEMS) break;
    const line = raw.trim();
    if (line.length < 4) continue;
    if (!/^[-*+]\s+/.test(line)) continue;
    out.push(line.replace(/^[-*+]\s+/, ""));
  }
  return out;
}

function classifyBullet(line: string): ExtractedItemType | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(line)) return rule.type;
  }
  return null;
}

/**
 * Build the deterministic-fallback CoercedItem list. The orchestrator
 * wraps each one in a final ExtractedItem in `buildExtractedItems`.
 */
export function buildHeuristicItems(input: HeuristicInput): CoercedItem[] {
  const items: CoercedItem[] = [];
  const summaryText = (input.summary ?? firstParagraph(input.markdown)).trim();
  if (summaryText.length > 0) {
    items.push({
      type: defaultTypeForSource(input.sourceType),
      title: input.title.length > 0 ? input.title : "Untitled source",
      content: summaryText.length > 1200 ? `${summaryText.slice(0, 1200).trim()}...` : summaryText,
      confidence: "low" satisfies Confidence,
      status: "suggested",
    });
  }

  for (const bullet of extractBullets(input.markdown)) {
    if (items.length >= MAX_HEURISTIC_ITEMS) break;
    const type = classifyBullet(bullet);
    if (type === null) continue;
    items.push({
      type,
      title: lineToTitle(bullet),
      content: bullet,
      confidence: "low" satisfies Confidence,
      status: "suggested",
    });
  }

  return items;
}

/** Stable per-source item id: `<sourceDocumentId>#<index>`. */
export function buildItemId(sourceDocumentId: string, index: number): string {
  return `${sourceDocumentId}#${index}`;
}

export function coercedToExtractedItem(
  coerced: CoercedItem,
  input: HeuristicInput,
  index: number
): ExtractedItem {
  return {
    id: buildItemId(input.sourceDocumentId, index),
    sourceDocumentId: input.sourceDocumentId,
    projectId: input.projectId ?? null,
    type: coerced.type,
    title: coerced.title,
    content: coerced.content,
    confidence: coerced.confidence,
    status: coerced.status,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
