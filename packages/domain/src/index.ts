import { z } from "zod";

// --- IDs ---
export type VentureId = string;
export type ArtifactId = string;
export type RunId = string;
export type ChatId = string;
export type TaskId = string;

// --- Stages ---
export const VentureStageSchema = z.enum([
  "IDEA",
  "RESEARCHED",
  "VALIDATED",
  "BRAND_READY",
  "UK_SETUP_READY",
  "SPEC_READY",
  "WIREFRAME_READY",
  "STITCH_READY",
  "BUILD_READY",
  "AUDIT_READY",
  "LAUNCH_READY",
  "LIVE",
]);
export type VentureStage = z.infer<typeof VentureStageSchema>;

export const VENTURE_STAGE_ORDER: VentureStage[] = [
  "IDEA",
  "RESEARCHED",
  "VALIDATED",
  "BRAND_READY",
  "UK_SETUP_READY",
  "SPEC_READY",
  "WIREFRAME_READY",
  "STITCH_READY",
  "BUILD_READY",
  "AUDIT_READY",
  "LAUNCH_READY",
  "LIVE",
];

// --- Entity / venture config ---
export const EntityTypeSchema = z.enum(["sole_trader", "ltd", "partnership", "undecided"]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const AppTypeSchema = z.enum([
  "web",
  "desktop",
  "mobile",
  "saas",
  "browser_extension",
  "game",
]);
export type AppType = z.infer<typeof AppTypeSchema>;

export const VentureManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  entityType: EntityTypeSchema,
  industry: z.string().optional(),
  appType: AppTypeSchema,
  regulated: z.boolean().default(false),
  takesPayments: z.boolean().default(false),
  handlesPersonalData: z.boolean().default(false),
  hiresStaff: z.boolean().default(false),
  monthlyBudgetCapGBP: z.number().optional(),
  currentStage: VentureStageSchema,
  blockers: z.array(z.string()).default([]),
});
export type VentureManifest = z.infer<typeof VentureManifestSchema>;

// --- Venture (runtime/db shape) ---
export const VentureSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  stage: VentureStageSchema,
  rootPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Venture = z.infer<typeof VentureSchema>;

// --- ArtifactRef (lightweight pointer used across packages) ---
export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  path: z.string(),
  type: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// --- Tasks ---
export const TaskStatusSchema = z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  ventureId: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  stage: VentureStageSchema.optional(),
  dueAt: z.string().optional(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

// --- UK Setup (pt.33) ---
// Re-exported so consumers of @founder-os/domain get the canvas types
// without an extra import path. The canvas itself lives in uk-setup.ts.
export * from "./uk-setup.js";

// --- Product Spec (pt.41) ---
// Same re-export pattern as UK Setup. The Spec canvas lives in spec.ts.
export * from "./spec.js";

// --- Screens (pt.43) ---
// Screen inventory canvas — narrower than full wireframes. Lives in
// 06_product/wireframes/screens-canvas.json. Stage enum is still
// WIREFRAME_READY (legacy from pre-pt.41) but the canvas + UI are
// scoped to a screen INVENTORY, not element-level layout. See
// screens.ts header for the deliberately-did-not policy.
export * from "./screens.js";
