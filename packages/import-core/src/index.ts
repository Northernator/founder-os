/**
 * @founder-os/import-core public entry -- CLIENT-SAFE.
 *
 * Slice 2 of the DREAM_VAULT_MODULE arc. Pure orchestration: lifecycle
 * state machine, content-hash dedupe, file-type detection (extension +
 * mime), and the injection-shaped ports. Zero node:* imports here so
 * the Tauri WebView can preview import staging before the Node side
 * touches disk.
 *
 * What lives in "./node":
 *   - hashFile (streaming sha256 via node:crypto + node:fs)
 *   - stageOriginal (copies file into _vault/_import-cache/)
 *   - magic-byte probe for renamed files
 *
 * Pattern mirrors @founder-os/handoff-pack-providers,
 * @founder-os/media-providers, @founder-os/handoff-providers.
 */

export {
  type FileTypeProbe,
  type FileTypeResult,
  detectFileType,
  extractExtension,
} from "./file-type";

export {
  IllegalImportJobTransitionError,
  type AdvanceJobInput,
  type RecordFileOutcomeInput,
  advanceJob,
  assertTransition,
  canTransition,
  isTerminalStatus,
  recordFileOutcome,
} from "./lifecycle";

export {
  type DedupeInput,
  type DedupeResult,
  type KnownHashStore,
  createInMemoryHashStore,
  dedupeByHash,
} from "./dedupe";

export {
  type HashFileFn,
  type ImportJobStore,
  type ImportLogger,
  type KnownHashLookup,
  type ProgressEmit,
  type ProgressEvent,
  type StageOriginalFn,
} from "./ports";

export {
  type CancelImportJobInput,
  type CommitImportJobInput,
  type CreateImportJobInput,
  type ImportCandidate,
  type MarkJobFailedInput,
  type ProcessImportJobInput,
  type ProcessImportJobResult,
  cancelImportJob,
  commitImportJob,
  createImportJob,
  defaultSourceIdFactory,
  markImportJobFailed,
  processImportJob,
} from "./orchestrator";

export {
  type SafelyRunOpts,
  type SafelyRunResult,
  safelyRunPerFile,
} from "./safely-run";
