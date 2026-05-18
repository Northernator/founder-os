// @founder-os/crm-core -- contract for the CRM_READY pipeline stage.
//
// Slice 1: types + zod schemas + parse helpers + defaults only.
// No provider implementations, no HTTP code -- those live in @founder-os/crm-providers
// (slice 2). See bizBuild/CRM-MODULE-SPEC.md for the design.
//
// Local-only: all three engines target localhost. The HTTP client guard
// in crm-providers rejects non-local hosts before any socket opens.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Engines + tier ordering
// ---------------------------------------------------------------------------

/**
 * CRM engines the pipeline knows how to dispatch to. All target localhost.
 * No hosted-SaaS surface in v1 -- this is a deliberate local-only design.
 */
export const CrmEngineSchema = z.enum([
  "frappe_docker", // tier_0 -- local Docker compose, recommended default
  "frappe_bench",  // tier_1 -- native bench install on this machine
  "config_only",   // tier_2 -- pipeline emits JSON only, no HTTP
]);
export type CrmEngine = z.infer<typeof CrmEngineSchema>;

/**
 * Default tier order for new ventures. config_only is always last and
 * never fails, so the stage can complete even without Docker or bench.
 * Override per venture in venture.yaml under crm.engineTiers.
 */
export const CRM_ENGINE_TIERS_DEFAULT: ReadonlyArray<CrmEngine> = [
  "frappe_docker",
  "frappe_bench",
  "config_only",
];

// ---------------------------------------------------------------------------
// Local-only HTTP guard allowlist
// ---------------------------------------------------------------------------

/**
 * Hostnames that the Frappe REST client is allowed to call. Any other
 * host is rejected before a socket opens. Removing entries here is a
 * code change, not a config flag -- that's the safety net that keeps
 * "local-only" honest.
 */
export const CRM_HTTP_LOCAL_HOSTNAMES: ReadonlyArray<string> = [
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default Docker host port for the Frappe web container. Override per
 * venture in venture.yaml under crm.docker.port.
 */
export const CRM_DOCKER_DEFAULT_PORT = 8000;

/**
 * Default Docker host port for the Frappe socketio container.
 */
export const CRM_DOCKER_DEFAULT_SOCKETIO_PORT = 9000;

/**
 * Pinned Frappe + ERPNext image tag. Slice 7 may swap this for a digest
 * once the install path is verified.
 */
export const CRM_DOCKER_DEFAULT_IMAGE = "frappe/erpnext:v15";

/**
 * Default data directory under the user's home. The Docker bind mount
 * lives here so site data survives container restarts.
 *
 * Token substitution happens in the provider -- the literal "<slug>" is
 * replaced with the venture slug at provision time.
 */
export const CRM_DOCKER_DEFAULT_DATA_DIR = "~/.founder-os/crm/<slug>/data";

/**
 * Bench default site URL when no override is set. Bench installs
 * conventionally bind to localhost:8000 like Docker.
 */
export const CRM_BENCH_DEFAULT_SITE_URL = "http://localhost:8000";

// ---------------------------------------------------------------------------
// Per-venture config (lives under VentureManifest.crm)
// ---------------------------------------------------------------------------

export const CrmDockerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  socketioPort: z.number().int().min(1).max(65535).optional(),
  image: z.string().optional(),
  /**
   * Path to the bind-mounted data directory. May contain "<slug>" and "~"
   * tokens; the provider resolves them at provision time.
   */
  dataDir: z.string().optional(),
});
export type CrmDockerConfig = z.infer<typeof CrmDockerConfigSchema>;

export const CrmBenchConfigSchema = z.object({
  siteUrl: z.string().url().optional(),
  /**
   * Filesystem path to an encrypted API key file. The runner reads, decrypts
   * in-process, and never writes the plaintext to disk or logs.
   */
  apiKeyPath: z.string().optional(),
});
export type CrmBenchConfig = z.infer<typeof CrmBenchConfigSchema>;

export const CrmSeedingConfigSchema = z.object({
  importResearchContacts: z.boolean().default(false),
  secondaryIcpSegments: z.boolean().default(true),
  autoSendLaunchCampaign: z.boolean().default(false),
});
export type CrmSeedingConfig = z.infer<typeof CrmSeedingConfigSchema>;

export const CrmConfigSchema = z.object({
  adminEmail: z.string().email(),
  engineTiers: z.array(CrmEngineSchema).default([...CRM_ENGINE_TIERS_DEFAULT]),
  docker: CrmDockerConfigSchema.optional(),
  bench: CrmBenchConfigSchema.optional(),
  seeding: CrmSeedingConfigSchema.default({
    importResearchContacts: false,
    secondaryIcpSegments: true,
    autoSendLaunchCampaign: false,
  }),
});
export type CrmConfig = z.infer<typeof CrmConfigSchema>;

// ---------------------------------------------------------------------------
// CrmInstance -- pipeline's record of "what we provisioned"
// ---------------------------------------------------------------------------

export const CrmInstanceSchema = z.object({
  ventureSlug: z.string(),
  engine: CrmEngineSchema,
  /**
   * Resolved site URL after provisioning. Always a localhost URL or
   * undefined (for config_only).
   */
  siteUrl: z.string().url().optional(),
  siteName: z.string().optional(),
  adminEmail: z.string().email(),
  /**
   * Filesystem reference to the encrypted API key. Never the key itself.
   * Undefined for config_only (no API calls happen).
   */
  apiKeyRef: z.string().optional(),
  provisionedAt: z.string().datetime(),
  notes: z.string().optional(),
});
export type CrmInstance = z.infer<typeof CrmInstanceSchema>;

// ---------------------------------------------------------------------------
// Segments / Contacts / Opportunities / Campaigns
// ---------------------------------------------------------------------------

export const CrmSegmentSourceSchema = z.enum(["validation_icp", "manual"]);
export type CrmSegmentSource = z.infer<typeof CrmSegmentSourceSchema>;

export const CrmCompanySizeSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
});
export type CrmCompanySize = z.infer<typeof CrmCompanySizeSchema>;

export const CrmSegmentCriteriaSchema = z.object({
  industries: z.array(z.string()).optional(),
  companySize: CrmCompanySizeSchema.optional(),
  geography: z.array(z.string()).optional(),
  jobsToBeDone: z.array(z.string()).optional(),
});
export type CrmSegmentCriteria = z.infer<typeof CrmSegmentCriteriaSchema>;

export const CrmSegmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: CrmSegmentSourceSchema,
  criteria: CrmSegmentCriteriaSchema,
});
export type CrmSegment = z.infer<typeof CrmSegmentSchema>;

export const CrmContactSourceSchema = z.enum([
  "sales_agents",
  "research_extract",
  "manual",
]);
export type CrmContactSource = z.infer<typeof CrmContactSourceSchema>;

export const CrmContactSchema = z.object({
  externalId: z.string().optional(),
  email: z.string().email().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  source: CrmContactSourceSchema,
  segmentIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type CrmContact = z.infer<typeof CrmContactSchema>;

export const CrmOpportunityStatusSchema = z.enum([
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);
export type CrmOpportunityStatus = z.infer<typeof CrmOpportunityStatusSchema>;

export const CrmOpportunitySourceSchema = z.enum(["sales_agents", "manual"]);
export type CrmOpportunitySource = z.infer<typeof CrmOpportunitySourceSchema>;

export const CrmOpportunitySchema = z.object({
  externalId: z.string().optional(),
  contactExternalId: z.string().optional(),
  title: z.string(),
  status: CrmOpportunityStatusSchema.default("lead"),
  estimatedValueGBP: z.number().nonnegative().optional(),
  source: CrmOpportunitySourceSchema,
  notes: z.string().optional(),
});
export type CrmOpportunity = z.infer<typeof CrmOpportunitySchema>;

export const CrmCampaignAssetTypeSchema = z.enum(["video", "image", "pdf"]);
export type CrmCampaignAssetType = z.infer<typeof CrmCampaignAssetTypeSchema>;

export const CrmCampaignAssetSchema = z.object({
  type: CrmCampaignAssetTypeSchema,
  /**
   * Path relative to the venture root, e.g. "10_media/exports/launch-reel.mp4".
   */
  sourcePath: z.string(),
  /**
   * Set after the asset has been uploaded into Frappe's File DocType.
   * Always a localhost URL or undefined for config_only.
   */
  hostedUrl: z.string().url().optional(),
});
export type CrmCampaignAsset = z.infer<typeof CrmCampaignAssetSchema>;

export const CrmCampaignSchema = z.object({
  id: z.string(),
  label: z.string(),
  templateIds: z.array(z.string()),
  segmentIds: z.array(z.string()),
  embeddedAssets: z.array(CrmCampaignAssetSchema).default([]),
  /**
   * v1 default is false -- the pre-send review gate enforces this.
   */
  autoSend: z.boolean().default(false),
});
export type CrmCampaign = z.infer<typeof CrmCampaignSchema>;

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

export const CrmEmailTemplateSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
});
export type CrmEmailTemplate = z.infer<typeof CrmEmailTemplateSchema>;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Implemented by all three local providers (Docker / bench / config_only).
 * Slice 2 ships the implementations; slice 1 only declares the contract.
 */
export interface CrmProvider {
  readonly name: CrmEngine;
  available(): Promise<boolean>;
  provision(input: ProvisionInput): Promise<CrmInstance>;
  upsertSegments(segments: CrmSegment[]): Promise<void>;
  upsertContacts(contacts: CrmContact[]): Promise<void>;
  upsertOpportunities(opps: CrmOpportunity[]): Promise<void>;
  upsertTemplates(templates: CrmEmailTemplate[]): Promise<void>;
  createCampaign(campaign: CrmCampaign): Promise<CrmCampaignResult>;
}

export type ProvisionInput = {
  ventureSlug: string;
  adminEmail: string;
  docker?: CrmDockerConfig;
  bench?: CrmBenchConfig;
};

export type CrmCampaignResult = {
  /**
   * Frappe-side id (Newsletter DocType name) or, for config_only,
   * the same id that was on the CrmCampaign.
   */
  id: string;
  /**
   * URL for the user to open in Frappe. Always localhost or undefined.
   */
  url?: string;
};

// ---------------------------------------------------------------------------
// Run-result envelope -- what the runner writes to crm-checkpoint.json
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parse helper re-exports -- the actual helpers live in parse.ts so callers
// can import the focused module if they want, but the barrel surface is the
// canonical entry point.
// ---------------------------------------------------------------------------

export {
  parseCrmConfig,
  safeParseCrmConfig,
  parseCrmInstance,
  safeParseCrmInstance,
  parseCrmSegment,
  safeParseCrmSegment,
  parseCrmContact,
  safeParseCrmContact,
  parseCrmOpportunity,
  safeParseCrmOpportunity,
  parseCrmCampaign,
  safeParseCrmCampaign,
  parseCrmCheckpoint,
  safeParseCrmCheckpoint,
} from "./parse.js";

export const CrmCheckpointSchema = z.object({
  runId: z.string(),
  ventureSlug: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum([
    "in_progress",
    "completed",
    "failed",
    "awaiting_review",
  ]),
  instance: CrmInstanceSchema.optional(),
  segmentsUpserted: z.number().int().nonnegative().default(0),
  contactsUpserted: z.number().int().nonnegative().default(0),
  opportunitiesUpserted: z.number().int().nonnegative().default(0),
  templatesUpserted: z.number().int().nonnegative().default(0),
  campaignId: z.string().optional(),
  campaignUrl: z.string().url().optional(),
  notes: z.array(z.string()).default([]),
});
export type CrmCheckpoint = z.infer<typeof CrmCheckpointSchema>;
