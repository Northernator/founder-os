/**
 * Slice 6 -- main entry point for the knowledge-extractor.
 *
 * `extractKnowledgeItems` is dual-mode:
 *   - callLlm provided -> ask the model for a JSON array, drop items
 *     that fail LlmItemSchema, keep the ones that pass.
 *   - callLlm absent OR LLM call fails OR every item is schema-invalid
 *     -> fall back to deterministic heuristics so the no-LLM smoke
 *        path always produces at least one item.
 *
 * Never imports a provider SDK -- callLlm is the boundary.
 */
import type { ExtractedItem } from "@founder-os/vault-contract";
import {
  buildHeuristicItems,
  buildItemId,
  coercedToExtractedItem,
} from "./heuristics.js";
import {
  KNOWLEDGE_SYSTEM_PROMPT,
  buildKnowledgeUserPrompt,
} from "./prompt.js";
import {
  type CoercedItem,
  type KnowledgeCallLlm,
  type KnowledgeExtractionInput,
  type KnowledgeExtractionResult,
  type LlmItem,
  LlmItemSchema,
} from "./types.js";

const DEFAULT_MAX_ITEMS = 12;

/**
 * Pull the JSON array out of an LLM response. Tolerant of:
 *   - bare JSON array,
 *   - ```json ... ``` fenced block,
 *   - any prose before/after a top-level [...] block (first match wins).
 *
 * Returns `null` when no parseable JSON array is found.
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Strip a leading ```json / ```` fence.
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)```\s*$/);
  const body = fenceMatch?.[1]?.trim() ?? trimmed;

  // Locate the first top-level [...] block. We bracket-walk so JSON
  // strings containing literal "]" don't confuse a naive lastIndexOf.
  const start = body.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          return Array.isArray(parsed) ? (parsed as unknown[]) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Coerce a raw LLM array into validated CoercedItem rows. Items that
 * fail LlmItemSchema are dropped; the caller surfaces drop counts via
 * `warnings`.
 */
export function coerceLlmItems(
  raw: unknown[],
  warnings: string[]
): CoercedItem[] {
  const out: CoercedItem[] = [];
  let droppedCount = 0;
  raw.forEach((entry, idx) => {
    const parsed = LlmItemSchema.safeParse(entry);
    if (!parsed.success) {
      droppedCount += 1;
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") || "(root)";
      warnings.push(`item #${idx}: schema-invalid (${path}: ${issue?.message ?? "?"})`);
      return;
    }
    out.push(toCoerced(parsed.data));
  });
  if (droppedCount > 0) {
    warnings.unshift(`dropped ${droppedCount} schema-invalid items`);
  }
  return out;
}

function toCoerced(item: LlmItem): CoercedItem {
  return {
    type: item.type,
    title: item.title.length > 120 ? `${item.title.slice(0, 117).trim()}...` : item.title,
    content: item.content,
    confidence: item.confidence ?? "medium",
    status: "suggested",
  };
}

export async function extractKnowledgeItems(
  input: KnowledgeExtractionInput,
  callLlm?: KnowledgeCallLlm
): Promise<KnowledgeExtractionResult> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;

  let llmItems: CoercedItem[] = [];
  let usedLlm = false;
  if (callLlm) {
    try {
      const raw = await callLlm({
        system: KNOWLEDGE_SYSTEM_PROMPT,
        user: buildKnowledgeUserPrompt(input),
      });
      const arr = extractJsonArray(raw);
      if (arr === null) {
        warnings.push("LLM response did not contain a JSON array");
      } else if (arr.length === 0) {
        notes.push("LLM returned an empty array");
      } else {
        llmItems = coerceLlmItems(arr, warnings);
        if (llmItems.length > 0) usedLlm = true;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      warnings.push(`LLM call failed: ${m}`);
    }
  }

  // Fall back to heuristics when the LLM produced nothing usable.
  let coerced: CoercedItem[];
  if (llmItems.length > 0) {
    coerced = llmItems.slice(0, maxItems);
  } else {
    coerced = buildHeuristicItems(input).slice(0, maxItems);
    if (callLlm) notes.push("LLM path produced no valid items -- using deterministic fallback");
  }

  const items: ExtractedItem[] = coerced.map((c, idx) =>
    coercedToExtractedItem(c, input, idx)
  );

  return { items, usedLlm, warnings, notes };
}

// Re-export utilities tests reach for directly.
export { buildItemId };
