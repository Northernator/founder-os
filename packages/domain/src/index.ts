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
  "SPEC_READY",
  "WIREFRAME_READY",
  "STITCH_READY",
  "BACKEND_READY",
  "BUILD_READY",
  "AUDIT_READY",
  "LAUNCH_READY",
  "MEDIA_READY",
  "MEDIA_EDIT_READY",
  "CRM_READY",
  "HANDOFF_PACK_READY",
  "UK_SETUP_READY",
  "LIVE",
]);
export type VentureStage = z.infer<typeof VentureStageSchema>;

export const VENTURE_STAGE_ORDER: VentureStage[] = [
  "IDEA",
  "RESEARCHED",
  "VALIDATED",
  "BRAND_READY",
  "SPEC_READY",
  "WIREFRAME_READY",
  "STITCH_READY",
  "BACKEND_READY",
  "BUILD_READY",
  "AUDIT_READY",
  "LAUNCH_READY",
  "MEDIA_READY",
  "MEDIA_EDIT_READY",
  "CRM_READY",
  "HANDOFF_PACK_READY",
  "UK_SETUP_READY",
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

// PipelineConfigSchema is defined in ./stage-runners.ts and re-exported
// from this barrel below. We import it here for VentureManifestSchema.
import { CrmConfigSchema } from "@founder-os/crm-core";
import { MediaConfigSchema } from "@founder-os/media-core";
import { MediaEditConfigSchema } from "@founder-os/media-edit-core";
import { SocialConfigSchema } from "@founder-os/social-core";
import { PipelineConfigSchema } from "./stage-runners.js";

const HandoffPackRoleSchema = z.enum([
  "founder",
  "dev",
  "designer",
  "marketing",
  "sales",
  "support",
  "finance",
  "contractor",
]);

const HandoffPackTierSchema = z.enum(["A", "B", "C", "D"]);

const HandoffPackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  includeRolePacks: z.array(HandoffPackRoleSchema).optional(),
  customCoverNote: z.string().default(""),
  excludeTiers: z.array(HandoffPackTierSchema).default([]),
});

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
  /**
   * Optional pipeline config. When absent, defaults are applied
   * (see PipelineConfigSchema). Existing manifests parse unchanged.
   */
  pipeline: PipelineConfigSchema.optional(),
  /**
   * Which provider runs at the HANDOFF stage. "stitch" routes to the
   * Google Stitch / v0 / Figma Make prompt+config flow; "codesign"
   * routes to Open CoDesign's parametric output. Defaults to "codesign"
   * for new ventures (see runner-side fallback) -- existing manifests
   * without this field are treated as "codesign" too. Mirrored as
   * HandoffSource in @founder-os/handoff-contract.
   */
  handoffSource: z.enum(["stitch", "codesign"]).optional(),
  /**
   * Per-venture media stage configuration (slice 8 of media arc).
   * Currently a single optional field `enabledEngines` -- the list
   * of MediaProvider engines this venture has opted in to. When
   * absent, the helper defaults to `["hyperframes", "gemini_flow"]`
   * (the two real paths). Stubs (wan2/cogvideox/gemini_api) must be
   * explicitly enabled.
   */
  media: MediaConfigSchema.optional(),
  /**
   * Per-venture media-edit stage configuration (slice 3 of media-edit
   * arc). OPTIONAL stage between MEDIA_READY and CRM_READY -- when
   * `enabled` is false or absent, MEDIA_EDIT is skipped and LAUNCH
   * reads the raw launch-reel.mp4 from MEDIA_READY. When enabled, the
   * runner spins up OpenCut (self-hosted via bun dev), waits for the
   * founder to drop a polished reel into 10_media/exports/edited/,
   * and stamps the venture's mediaEdit-ready state.
   */
  mediaEdit: MediaEditConfigSchema.optional(),
  /**
   * Per-venture CRM stage configuration (slice 3 of crm arc).
   * Optional -- ventures without this block run CRM with all defaults
   * (tier list = docker/bench/config_only, no docker overrides). The
   * adminEmail field is required at the schema level when crm is set
   * because the Docker first-boot flow needs a real address to create
   * the Frappe admin user.
   */
  crm: CrmConfigSchema.optional(),
  /**
   * Per-venture handoff-pack configuration. Optional -- ventures without
   * this block render all tiers and all default role packs.
   */
  handoffPack: HandoffPackConfigSchema.optional(),
  /**
   * Per-venture social-posting configuration (SOCIAL-MODULE follow-up
   * arc). OPTIONAL -- ventures without this block default to:
   *   backend: "social-poster"
   *   enabledBackends: ["social-poster", "postiz"]
   *   enabledPlatforms: ["x", "linkedin", "bluesky"]
   * The `postiz` sub-config (baseUrl + apiKeyEnvVar) is required when a
   * venture switches backend to "postiz" -- the Postiz config picker in
   * SocialActions persists it here. social-poster needs no per-venture
   * config (PATH-resolved binary + browser cookies).
   */
  social: SocialConfigSchema.optional(),
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

// --- Stage runners (slice 1 of stage-runners feature) ---
// StageName + StageRunResult + ReviewGate + StageProgress contracts
// consumed by @founder-os/stage-runners. Distinct from VentureStage:
// StageName names the running stage, VentureStage names the
// post-completion state. STAGE_PRODUCES bridges the two.
export * from "./stage-runners.js";

// --- Stage graph (pipeline-hardening, 2026-05-18) ---
// Canonical metadata table for every stage. Single source of truth
// for label / folder / dependencies / producedVentureStage / review
// gate / provider-required / tab owner. Coexists with STAGE_NAME_ORDER
// and STAGE_PRODUCES during the migration; consumers can move to
// STAGE_GRAPH at their own pace.
export * from "./stage-graph.js";
