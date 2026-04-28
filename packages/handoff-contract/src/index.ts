import { z } from "zod";
import { ArtifactRefSchema } from "@founder-os/domain";
import { AuditSummarySchema } from "@founder-os/audit-contract";

export const HandoffRequestTypeSchema = z.enum([
  "BUILD_FROM_STITCH_EXPORT",
  "BUILD_FROM_BRIEF",
  "GENERATE_CODE_WIKI",
  "GENERATE_TRUTH_LAYER",
  "RUN_AUDIT",
  "RUN_RED_TEAM_PASS",
]);
export type HandoffRequestType = z.infer<typeof HandoffRequestTypeSchema>;

export const HandoffBundleSchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  type: HandoffRequestTypeSchema,
  createdAt: z.string(),
  ventureRoot: z.string(),
  artifactRefs: z.array(ArtifactRefSchema).default([]),
  payload: z.record(z.unknown()).default({}),
  schemaVersion: z.literal(1).default(1),
});
export type HandoffBundle = z.infer<typeof HandoffBundleSchema>;

export const HandoffStatusSchema = z.enum([
  "accepted",
  "running",
  "success",
  "failed",
  "cancelled",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const HandoffProgressEventSchema = z.object({
  runId: z.string(),
  status: HandoffStatusSchema,
  message: z.string().optional(),
  percentComplete: z.number().min(0).max(100).optional(),
  emittedAt: z.string(),
});
export type HandoffProgressEvent = z.infer<typeof HandoffProgressEventSchema>;

export const HandoffResultSchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  status: HandoffStatusSchema,
  producedArtifacts: z.array(ArtifactRefSchema).default([]),
  auditSummary: AuditSummarySchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  completedAt: z.string(),
  schemaVersion: z.literal(1).default(1),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

// --- Validation helpers (the whole point of this package) ---

export function parseBundle(raw: unknown): HandoffBundle {
  return HandoffBundleSchema.parse(raw);
}

export function safeParseBundle(raw: unknown) {
  return HandoffBundleSchema.safeParse(raw);
}

export function parseResult(raw: unknown): HandoffResult {
  return HandoffResultSchema.parse(raw);
}

export function safeParseResult(raw: unknown) {
  return HandoffResultSchema.safeParse(raw);
}

export function generateRunId(): string {
  // timestamp + random suffix; good enough for filesystem-scoped uniqueness
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}
