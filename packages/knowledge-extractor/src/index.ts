/**
 * @founder-os/knowledge-extractor public entry -- CLIENT-SAFE.
 *
 * Slice 6 of the DREAM_VAULT_MODULE arc. Pulls atomic `ExtractedItem`
 * rows out of an already-extracted markdown blob. The LLM call is
 * injected via the existing streamChat dispatcher (subscription-first
 * routing) so this package never imports a provider SDK directly. When
 * no callLlm is wired or the LLM fails, deterministic heuristics fire
 * so the offline smoke path always produces at least one item.
 */

export {
  type CoercedItem,
  type HeuristicInput,
  type KnowledgeCallLlm,
  type KnowledgeExtractionInput,
  type KnowledgeExtractionResult,
  type LlmItem,
  KnowledgeExtractorError,
  LlmItemSchema,
} from "./types";

export {
  buildHeuristicItems,
  buildItemId,
  coercedToExtractedItem,
} from "./heuristics";

export {
  KNOWLEDGE_SYSTEM_PROMPT,
  buildKnowledgeUserPrompt,
} from "./prompt";

export {
  coerceLlmItems,
  extractJsonArray,
  extractKnowledgeItems,
} from "./extract";
