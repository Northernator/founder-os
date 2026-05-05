/**
 * Re-exports the stage-runner contracts from @founder-os/domain so
 * consumers of this package have a single import surface.
 *
 * The interface for a runner (StageRunner) lives here rather than in
 * domain because it ties type contracts to an execution port and is
 * runner-package-internal — domain stays pure data.
 */
export type {
  ArtifactIndexEntry,
  FailedRunEntry,
  LogEntry,
  LogLevel,
  PipelineConfig,
  ReviewApprovalKind,
  ReviewArtifact,
  ReviewGate,
  ReviewGateStatus,
  StageName,
  StageProgress,
  StageRunError,
  StageRunResult,
  ValidationResult,
} from "@founder-os/domain";

export {
  ArtifactIndexEntrySchema,
  DEFAULT_REVIEW_GATES,
  FailedRunEntrySchema,
  LogEntrySchema,
  LogLevelSchema,
  PipelineConfigSchema,
  ReviewApprovalKindSchema,
  ReviewArtifactSchema,
  ReviewGateSchema,
  ReviewGateStatusSchema,
  STAGE_NAME_ORDER,
  STAGE_PRODUCES,
  StageNameSchema,
  StageProgressSchema,
  StageRunErrorSchema,
  StageRunResultSchema,
  ValidationResultSchema,
} from "@founder-os/domain";

import type { StageName, StageRunResult, ValidationResult } from "@founder-os/domain";

/**
 * Runtime contract every stage runner must implement.
 *
 * Inspired by MoneyPrinter V2's per-channel agent pattern (YouTube.py,
 * Twitter.py) but adapted for the Founder OS pipeline:
 *  - validate() does preflight checks (API keys, prereq stages complete)
 *  - run()      is idempotent + resumable; writes artifacts to canonical
 *               paths under the venture root and emits structured logs
 *  - cleanup() is optional, for temp-file removal etc.
 *
 * Concrete runners are implemented in slice 2+ (ResearchStageRunner,
 * BrandStageRunner, …) and live under ./runners/.
 */
export interface StageRunner {
  readonly stageName: StageName;
  validate(): Promise<ValidationResult>;
  run(): Promise<StageRunResult>;
  cleanup?(): Promise<void>;
}
