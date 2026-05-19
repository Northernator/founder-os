/**
 * @founder-os/vault-runner public entry -- CLIENT-SAFE.
 *
 * Slice 8 of the DREAM_VAULT_MODULE arc. Mirrors the stage-runner
 * shape (class with `validate()` + `run()`) but adds a separate
 * `finalize()` because the Dream Vault import has a mandatory
 * human-review gate between phases 8 and 9. Drafts produced by
 * `run()` are held in-memory; `finalize()` writes them via the
 * injected VaultFsPort after the reviewer's approvals come in.
 */

export {
  type ChatExtractorPort,
  type DocumentExtractorPort,
  type ExtractorPortInput,
  type ImageExtractorPort,
  type VaultFinalizeInput,
  type VaultFinalizeResult,
  type VaultLogEntry,
  type VaultLogLevel,
  type VaultNoteDraft,
  type VaultRunResult,
  type VaultRunnerOpts,
  type VaultSourceApproval,
  type VaultSourceProcessing,
  VaultRunnerError,
} from "./types";

export { VAULT_LOG_STRINGS, type VaultLogKey } from "./log-strings";

export {
  dispatchExtraction,
  summariseExtractionCounts,
} from "./extract-stage";

export {
  pickBestVentureSlug,
  runClassifyStage,
} from "./classify-stage";

export { runKnowledgeStage } from "./knowledge-stage";

export {
  buildDraftId,
  buildDraftsForSource,
} from "./notes-stage";

export { VaultStageRunner } from "./runner";
