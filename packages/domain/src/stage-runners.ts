/**
 * Stage runner contracts (slice 1 of stage-runners feature).
 *
 * These types describe the shape of a single stage execution — used by
 * @founder-os/stage-runners and consumed by the desktop app + pipeline
 * orchestrator. Disk-bound shapes (StageProgress, ReviewGate,
 * ArtifactIndexEntry) are zod-validated so the JSON files under
 * .founder/state/ stay structurally honest as the schema evolves.
 *
 * Naming: this file uses StageName for "the stage that is running"
 * (e.g. BRAND, AUDIT). That is distinct from VentureStage in
 * index.ts which names the post-completion state of a venture
 * (e.g. BRAND_READY). STAGE_PRODUCES bridges the two.
 */
import { z } from "zod";

// VentureStage literal kept in sync with VentureStageSchema in ./index.ts.
// Duplicated here (rather than imported) to avoid a circular module import,
// since ./index.ts imports PipelineConfigSchema from this file. If the
// VentureStageSchema enum changes, update VentureStageMarker below to match.
type VentureStageMarker =
  | "IDEA"
  | "RESEARCHED"
  | "VALIDATED"
  | "BRAND_READY"
  | "UK_SETUP_READY"
  | "SPEC_READY"
  | "WIREFRAME_READY"
  | "STITCH_READY"
  | "BUILD_READY"
  | "AUDIT_READY"
  | "LAUNCH_READY"
  | "MEDIA_READY"
  | "LIVE";

// --- Stage names (the running stage, not the post-completion state) ---
export const StageNameSchema = z.enum([
  "RESEARCH",
  "VALIDATION",
  "BRAND",
  "UK_SETUP",
  "FINANCE",
  "PRODUCT_SPEC",
  "WIREFRAME",
  "HANDOFF",
  "BUILD",
  "AUDIT",
  "LAUNCH",
  "MEDIA",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const STAGE_NAME_ORDER: StageName[] = [
  "RESEARCH",
  "VALIDATION",
  "BRAND",
  "UK_SETUP",
  "FINANCE",
  "PRODUCT_SPEC",
  "WIREFRAME",
  "HANDOFF",
  "BUILD",
  "AUDIT",
  "LAUNCH",
  "MEDIA",
];

/**
 * Maps each StageName to the VentureStage marker it produces on
 * successful completion. Used by the orchestrator to advance the
 * venture's currentStage after a stage runner finishes.
 */
export const STAGE_PRODUCES = {
  RESEARCH: "RESEARCHED",
  VALIDATION: "VALIDATED",
  BRAND: "BRAND_READY",
  UK_SETUP: "UK_SETUP_READY",
  FINANCE: "BRAND_READY", // finance is parallel to brand; doesn't advance the gate
  PRODUCT_SPEC: "SPEC_READY",
  WIREFRAME: "WIREFRAME_READY",
  HANDOFF: "STITCH_READY",
  BUILD: "BUILD_READY",
  AUDIT: "AUDIT_READY",
  LAUNCH: "LAUNCH_READY",
  MEDIA: "MEDIA_READY",
} as const satisfies Record<StageName, VentureStageMarker>;

// --- Log entries (in-memory + JSONL on disk) ---
export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  level: LogLevelSchema,
  message: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

// --- Validation result (preflight check before run()) ---
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  missingResources: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// --- Stage run result (returned from runner.run()) ---
export const StageRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});
export type StageRunError = z.infer<typeof StageRunErrorSchema>;

export const StageRunResultSchema = z.object({
  success: z.boolean(),
  stageName: StageNameSchema,
  runId: z.string(),
  artifactsCreated: z.array(z.string()).default([]),
  logs: z.array(LogEntrySchema).default([]),
  requiresReview: z.boolean().default(false),
  reviewGateId: z.string().optional(),
  nextStageReady: z.boolean(),
  error: StageRunErrorSchema.optional(),
});
export type StageRunResult = z.infer<typeof StageRunResultSchema>;

// --- Artifact index entry (on disk: .founder/artifacts/index.json) ---
export const ArtifactIndexEntrySchema = z.object({
  artifactId: z.string(),
  stageName: StageNameSchema,
  type: z.string(),
  path: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "ready", "failed"]),
  runId: z.string().optional(),
});
export type ArtifactIndexEntry = z.infer<typeof ArtifactIndexEntrySchema>;

// --- Stage progress (on disk: .founder/state/stage-progress.json) ---
export const StageProgressSchema = z.object({
  currentStage: StageNameSchema,
  completedStages: z.array(StageNameSchema).default([]),
  startedAt: z.string(),
  updatedAt: z.string().optional(),
});
export type StageProgress = z.infer<typeof StageProgressSchema>;

// --- Review gate (on disk: .founder/state/review-gates.json) ---
export const ReviewApprovalKindSchema = z.enum(["legal", "design", "business", "security"]);
export type ReviewApprovalKind = z.infer<typeof ReviewApprovalKindSchema>;

export const ReviewGateStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ReviewGateStatus = z.infer<typeof ReviewGateStatusSchema>;

export const ReviewArtifactSchema = z.object({
  path: z.string(),
  type: z.string(),
  humanReadableContent: z.string(),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

export const ReviewGateSchema = z.object({
  gateId: z.string(),
  stageName: StageNameSchema,
  runId: z.string(),
  artifactsForReview: z.array(ReviewArtifactSchema).default([]),
  requiredApproval: ReviewApprovalKindSchema,
  status: ReviewGateStatusSchema,
  createdAt: z.string(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  feedback: z.string().optional(),
});
export type ReviewGate = z.infer<typeof ReviewGateSchema>;

// --- Pipeline config (lives under venture.yaml `pipeline:`) ---
export const PipelineConfigSchema = z.object({
  /**
   * Subset of StageName values that should pause for human review
   * on completion. If absent, defaults to ["BRAND", "AUDIT"].
   */
  reviewGates: z.array(StageNameSchema).default(["BRAND", "AUDIT"]),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export const DEFAULT_REVIEW_GATES: StageName[] = ["BRAND", "AUDIT"];

// --- Failed run index (on disk: .founder/state/failed-runs.json) ---
// Slice 5 of stage-runners feature. The orchestrator already drops a
// per-run StageRunResult JSON into .founder/handoffs/failed/ for
// forensics; this slim index is the queryable surface the desktop UI
// reads to build a "retry failed runs" affordance. We keep both to
// avoid adding a listDir method to the Filesystem port (current
// adapters expose mkdir/exists/readFile/writeFile only).
export const FailedRunEntrySchema = z.object({
  stageName: StageNameSchema,
  runId: z.string(),
  failedAt: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  recoverable: z.boolean(),
  /**
   * Path of the per-run StageRunResult dump under
   * .founder/handoffs/failed/. Lets the UI link straight to the full
   * payload (logs, artifactsCreated) without re-deriving the path.
   */
  resultPath: z.string(),
});
export type FailedRunEntry = z.infer<typeof FailedRunEntrySchema>;
