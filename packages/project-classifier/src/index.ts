/**
 * @founder-os/project-classifier public entry -- CLIENT-SAFE.
 *
 * Slice 6 of the DREAM_VAULT_MODULE arc. Routes an incoming source
 * document to one or more candidate ventures (with a confidence score)
 * via an injected LLM. When no callLlm is wired or the LLM fails,
 * keyword-overlap heuristics fire so the offline smoke path always
 * produces at least one match (falling back to "unsorted" when nothing
 * scores).
 *
 * Never imports a provider SDK -- callLlm is the boundary.
 */

export {
  type ClassifierCallLlm,
  type ClassifyDocumentInput,
  type ClassifyDocumentResult,
  type CoercedMatch,
  type LlmScore,
  type ProjectCandidate,
  LlmScoreSchema,
  ProjectClassifierError,
} from "./types";

export {
  buildHeuristicMatches,
  scoreCandidate,
} from "./heuristics";

export {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from "./prompt";

export {
  buildMatchId,
  classifyDocument,
  coerceLlmScores,
  extractJsonArray,
} from "./classify";
