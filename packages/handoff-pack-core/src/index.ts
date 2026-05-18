// @founder-os/handoff-pack-core -- contract for the HANDOFF_PACK pipeline stage.
//
// Slice 1: types + zod schemas + parse helpers + defaults + the 200+ entry
// document manifest. Contract-only, no providers, no fs, no PDF rendering --
// those live in @founder-os/handoff-pack-providers (slice 2) and
// packages/handoff-pack-templates/ (slice 3). See
// bizBuild/HANDOFF-PACK-MODULE-SPEC.md for the design.
//
// Dual-tree design: existing 00_inbox..12_backend stage folders are untouched.
// A new 13_handoff_pack/ tree contains the audience-organised 00-10 layout
// populated with branded PDFs only. HANDOFF_PACK runs LAST in the pipeline
// (after CRM) and is the first stage that conceptually OWNS this new tree.
//
// Doc tiering -- every descriptor declares its `tier`:
//   A: Golden 15 -- LLM-generated from existing stage outputs.
//   B: Extended ~30 -- LLM-generated, lower fidelity.
//   C: Partial-stub ~50 -- placeholders filled from manifest/brand/product,
//      bulk written by the founder.
//   D: Pure stub ~105 -- branded blank with TODO callouts.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Top-level folder + file constants
// ---------------------------------------------------------------------------

/** The new tree's root, lives alongside 00_inbox..12_backend at the venture root. */
export const HANDOFF_PACK_DIR_NAME = "13_handoff_pack";

/** Brand-asset subdirectory the PDF renderer pulls logo + tokens from. */
export const HANDOFF_PACK_BRAND_DIR_NAME = ".brand";

/** Where the 8 role-pack PDFs live. */
export const HANDOFF_PACK_ROLE_PACKS_DIR_NAME = "role-packs";

/** Human-readable inventory the HANDOFF_PACK runner writes on every run. */
export const HANDOFF_PACK_INDEX_FILE_NAME = "INDEX.md";

/** The runner's machine-readable checkpoint, like the other stage runners. */
export const HANDOFF_PACK_CHECKPOINT_FILE_NAME = "handoff-pack-checkpoint.json";

// ---------------------------------------------------------------------------
// The 11 audience categories
// ---------------------------------------------------------------------------

/**
 * The 11 audience-organised category slots. ORDER MATTERS -- it controls
 * the INDEX.md ordering AND the role-pack assembly ordering. Mirrors
 * the brief's section A-O layout flattened into 11 slots.
 */
export const CategorySlotSchema = z.enum([
  "00-company-control",
  "01-strategy",
  "02-product",
  "03-design-brand",
  "04-engineering",
  "05-security-data-compliance",
  "06-people-hr",
  "07-finance-admin",
  "08-sales-marketing",
  "09-customer-success",
  "10-templates",
]);
export type CategorySlot = z.infer<typeof CategorySlotSchema>;

/** Ordered list of all 11 slots -- useful for iteration without re-listing. */
export const CATEGORY_SLOTS: ReadonlyArray<CategorySlot> = [
  "00-company-control",
  "01-strategy",
  "02-product",
  "03-design-brand",
  "04-engineering",
  "05-security-data-compliance",
  "06-people-hr",
  "07-finance-admin",
  "08-sales-marketing",
  "09-customer-success",
  "10-templates",
];

/**
 * The on-disk folder name for each category slot. Currently identical to
 * the slot ID but kept as a separate map so the rename is one-edit
 * (slot IDs are programmatic identifiers; folder names are user-visible
 * and might want hyphenation tweaks later).
 */
export const CATEGORY_DIR_NAMES: Record<CategorySlot, string> = {
  "00-company-control": "00-company-control",
  "01-strategy": "01-strategy",
  "02-product": "02-product",
  "03-design-brand": "03-design-brand",
  "04-engineering": "04-engineering",
  "05-security-data-compliance": "05-security-data-compliance",
  "06-people-hr": "06-people-hr",
  "07-finance-admin": "07-finance-admin",
  "08-sales-marketing": "08-sales-marketing",
  "09-customer-success": "09-customer-success",
  "10-templates": "10-templates",
};

// ---------------------------------------------------------------------------
// Doc tiering + audience
// ---------------------------------------------------------------------------

/**
 * Generation strategy for each doc. See sec 4 of the spec.
 *   A: Golden 15 -- LLM-generated from prior stage outputs.
 *   B: ~30 extended generated -- same pattern, lower fidelity.
 *   C: ~50 partial stub with pipeline-derived placeholders.
 *   D: ~105 pure stubs -- branded blanks with TODO callouts.
 */
export const TierSchema = z.enum(["A", "B", "C", "D"]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Which role(s) should receive a copy of this doc in their role pack.
 * A doc can be in multiple role packs (e.g. Code of Conduct goes to
 * employees AND contractors). The role-pack assembler dedupes by docId.
 */
export const RoleSchema = z.enum([
  "founder",
  "dev",
  "designer",
  "marketing",
  "sales",
  "support",
  "finance",
  "contractor",
]);
export type Role = z.infer<typeof RoleSchema>;

export const DEFAULT_ROLE_PACK_NAMES: ReadonlyArray<Role> = [
  "founder",
  "dev",
  "designer",
  "marketing",
  "sales",
  "support",
  "finance",
  "contractor",
];

/**
 * Pipeline stages a doc may consume to generate its content. Matches
 * the canonical StageName enum from @founder-os/domain but kept local
 * to avoid a runtime dep on the full StageName surface (this is a
 * contract-only package). Stay in sync with domain/StageName.
 *
 * Note: HANDOFF_PACK itself doesn't appear here -- a doc never sources
 * itself.
 */
export const SourceStageSchema = z.enum([
  "RESEARCH",
  "VALIDATION",
  "BRAND",
  "UK_SETUP",
  "FINANCE",
  "PRODUCT_SPEC",
  "WIREFRAME",
  "HANDOFF",
  "BACKEND",
  "BUILD",
  "AUDIT",
  "LAUNCH",
  "MEDIA",
  "CRM",
]);
export type SourceStage = z.infer<typeof SourceStageSchema>;

// ---------------------------------------------------------------------------
// DocDescriptor -- the manifest's atomic unit
// ---------------------------------------------------------------------------

/**
 * One entry in the document manifest. Every PDF that lands in
 * 13_handoff_pack/ corresponds to exactly one descriptor.
 *
 * The `slot` field is a zero-padded integer that determines ordering
 * within a category folder (e.g. "00-company-brief.pdf" sorts before
 * "01-founder-vision.pdf"). The manifest authors pick these so the
 * folder reads in a sensible order for a new hire opening it cold.
 *
 * The `placeholders` array enumerates the Handlebars variables the
 * template references. The renderer cross-checks at build time that
 * every placeholder is satisfied by either a manifest-derived value,
 * a brand-token, or a TODO callout.
 */
export const DocDescriptorSchema = z.object({
  /** Stable identifier; used in role-pack ordering + INDEX.md anchors. */
  id: z.string().min(1),
  category: CategorySlotSchema,
  /** Two-digit slot prefix for the PDF filename, "00".."99". */
  slot: z.string().regex(/^\d{2}$/, "slot must be two-digit zero-padded"),
  title: z.string().min(1),
  /**
   * One-line description for INDEX.md and the desktop tab's per-doc row.
   * Keep under 120 chars.
   */
  description: z.string().min(1),
  tier: TierSchema,
  /** Which roles get this in their pack. Empty = no role pack. */
  roles: z.array(RoleSchema).default([]),
  /**
   * Stages whose outputs feed this doc's generation. Empty for tier-D
   * pure stubs that read nothing from the pipeline. The renderer uses
   * this to skip docs whose source stages haven't run yet.
   */
  sourceStages: z.array(SourceStageSchema).default([]),
  /**
   * Path under packages/handoff-pack-templates/ relative to that package
   * root, e.g. "00-company-control/00-company-brief.md.hbs". The
   * provider package resolves this against its own location.
   */
  templatePath: z.string().min(1),
  /** Handlebars variable names the template references. */
  placeholders: z.array(z.string()).default([]),
});
export type DocDescriptor = z.infer<typeof DocDescriptorSchema>;

/**
 * Compute the on-disk PDF basename for a descriptor. Pure -- no fs.
 * e.g. { slot: "00", id: "company-brief" } -> "00-company-brief.pdf".
 */
export function pdfBasenameFor(descriptor: DocDescriptor): string {
  return `${descriptor.slot}-${descriptor.id}.pdf`;
}

/**
 * Compute the relative-to-13_handoff_pack path for a descriptor's PDF,
 * using forward slashes only. The workspace-core path helper composes
 * this with the venture root + OS-correct separators.
 */
export function pdfRelativePathFor(descriptor: DocDescriptor): string {
  return `${CATEGORY_DIR_NAMES[descriptor.category]}/${pdfBasenameFor(descriptor)}`;
}

// ---------------------------------------------------------------------------
// BrandTokens -- the .brand/brand-tokens.json shape
// ---------------------------------------------------------------------------

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "expected #RRGGBB hex");

export const BrandColorsSchema = z.object({
  primary: HexColorSchema,
  secondary: HexColorSchema,
  background: HexColorSchema,
  text: HexColorSchema,
});
export type BrandColors = z.infer<typeof BrandColorsSchema>;

export const BrandFontsSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  mono: z.string().min(1),
});
export type BrandFonts = z.infer<typeof BrandFontsSchema>;

export const BrandTokensSchema = z.object({
  /** Relative path (from 13_handoff_pack/) to the SVG logo. */
  logoSvgPath: z.string().min(1),
  /** Relative path (from 13_handoff_pack/) to the rasterised PNG fallback. */
  logoPngPath: z.string().min(1),
  /** Human-readable company name -- mirrors VentureManifest.name. */
  companyName: z.string().min(1),
  colors: BrandColorsSchema,
  fonts: BrandFontsSchema,
  /** ISO datetime; the renderer surfaces this as "brand extracted at". */
  extractedAt: z.string().datetime(),
});
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

/** Fallback values when brand-brief.json doesn't declare the field. */
export const DEFAULT_FALLBACK_PRIMARY_HEX = "#1F2937";
export const DEFAULT_FALLBACK_SECONDARY_HEX = "#6B7280";
export const DEFAULT_FALLBACK_BACKGROUND_HEX = "#FFFFFF";
export const DEFAULT_FALLBACK_TEXT_HEX = "#111827";

/** Default font stack mirrored from createBrandBriefStep defaults. */
export const DEFAULT_HEADING_FONT = "Inter";
export const DEFAULT_BODY_FONT = "Inter";
export const DEFAULT_MONO_FONT = "JetBrains Mono";

/** PNG fallback dimensions for PDF engines that can't render the SVG. */
export const DEFAULT_LOGO_PNG_SIZE_PX = 600;

// ---------------------------------------------------------------------------
// PdfTemplateConfig -- the .brand/pdf-template-config.json shape
// ---------------------------------------------------------------------------

export const PageSizeSchema = z.enum(["A4", "Letter"]);
export type PageSize = z.infer<typeof PageSizeSchema>;

export const PageMarginsSchema = z.object({
  topMm: z.number().nonnegative(),
  rightMm: z.number().nonnegative(),
  bottomMm: z.number().nonnegative(),
  leftMm: z.number().nonnegative(),
});
export type PageMargins = z.infer<typeof PageMarginsSchema>;

export const PdfTemplateConfigSchema = z.object({
  pageSize: PageSizeSchema.default("A4"),
  margins: PageMarginsSchema.default({
    topMm: 18,
    rightMm: 18,
    bottomMm: 18,
    leftMm: 18,
  }),
  /** Header band height in mm. Holds logo + company name + doc category. */
  headerHeightMm: z.number().positive().default(24),
  /** Footer band height in mm. Holds version + date + copyright + page-of. */
  footerHeightMm: z.number().positive().default(18),
  /**
   * Free-form text appended to every footer after the copyright. e.g.
   * "Confidential -- Acme Corp internal use only". Empty -> nothing extra.
   */
  footerConfidentialityNote: z.string().default(""),
  /** Whether to underline H2 with a primary-colour rule. */
  accentH2Underline: z.boolean().default(true),
});
export type PdfTemplateConfig = z.infer<typeof PdfTemplateConfigSchema>;

/** Default page size for new ventures (A4 -- UK default; founder is UK). */
export const DEFAULT_PAGE_SIZE: PageSize = "A4";

/** Default page margins in mm; matches the spec sec 5 mock. */
export const DEFAULT_PAGE_MARGINS_MM: PageMargins = {
  topMm: 18,
  rightMm: 18,
  bottomMm: 18,
  leftMm: 18,
};

export const DEFAULT_HEADER_HEIGHT_MM = 24;
export const DEFAULT_FOOTER_HEIGHT_MM = 18;

// ---------------------------------------------------------------------------
// RolePackDescriptor -- one of the 8 role packs
// ---------------------------------------------------------------------------

export const RolePackDescriptorSchema = z.object({
  role: RoleSchema,
  /** Display title rendered on the role pack's cover page. */
  title: z.string().min(1),
  /**
   * Per-role intro paragraph. Plain text, no markdown, max ~400 chars.
   * Rendered below the title on the cover page.
   */
  introText: z.string().min(1),
  /**
   * Ordered list of doc IDs this pack bundles. The assembler resolves
   * each ID against the manifest and concatenates the corresponding
   * PDFs in this order. IDs not in the manifest are skipped with a
   * warning logged (defensive; manifest drift detection).
   */
  docIds: z.array(z.string().min(1)).min(1),
});
export type RolePackDescriptor = z.infer<typeof RolePackDescriptorSchema>;

/** Compute the on-disk PDF basename for a role pack. */
export function rolePackBasenameFor(role: Role): string {
  return `${role}-pack.pdf`;
}

// ---------------------------------------------------------------------------
// HandoffPackInventory -- INDEX.md's machine-readable twin
// ---------------------------------------------------------------------------

export const DocRenderStatusSchema = z.enum([
  "generated",       // tier A/B successfully LLM-generated
  "stub",            // tier D rendered, blank with TODO callouts
  "partial",         // tier C rendered with some placeholders filled
  "pending",         // descriptor known but not yet rendered (source stages
                     // haven't run)
  "manual",          // explicitly marked by the founder as hand-written
                     // outside the pipeline; pack copies the founder's file
  "failed",          // rendering attempted, threw -- INDEX.md surfaces the
                     // reason for triage
]);
export type DocRenderStatus = z.infer<typeof DocRenderStatusSchema>;

export const InventoryEntrySchema = z.object({
  docId: z.string().min(1),
  category: CategorySlotSchema,
  slot: z.string().regex(/^\d{2}$/),
  title: z.string().min(1),
  tier: TierSchema,
  status: DocRenderStatusSchema,
  /** Relative path from 13_handoff_pack/ to the rendered PDF. */
  pdfRelativePath: z.string().min(1),
  /** ISO datetime of last successful render. Absent when status=pending. */
  lastRenderedAt: z.string().datetime().optional(),
  /** Failure reason when status=failed. */
  failureReason: z.string().optional(),
});
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

export const HandoffPackInventorySchema = z.object({
  generatedAt: z.string().datetime(),
  ventureSlug: z.string().min(1),
  ventureName: z.string().min(1),
  /** Total descriptor count -- sanity check against the static manifest. */
  totalDocs: z.number().int().nonnegative(),
  entries: z.array(InventoryEntrySchema),
  /**
   * Per-role-pack render status. Keys are Role values; values are
   * "generated" / "skipped" / "failed". Skipped means the venture's
   * manifest excluded this role from `includeRolePacks`.
   */
  rolePacks: z.record(
    RoleSchema,
    z.enum(["generated", "skipped", "failed"])
  ),
});
export type HandoffPackInventory = z.infer<typeof HandoffPackInventorySchema>;

// ---------------------------------------------------------------------------
// HandoffPackCheckpoint -- the runner's checkpoint envelope
// ---------------------------------------------------------------------------

export const HandoffPackCheckpointSchema = z.object({
  runId: z.string().min(1),
  ventureSlug: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum([
    "in_progress",
    "completed",
    "failed",
    "awaiting_review",
    "skipped",
  ]),
  docsRendered: z.number().int().nonnegative().default(0),
  docsStubbed: z.number().int().nonnegative().default(0),
  docsPartial: z.number().int().nonnegative().default(0),
  docsFailed: z.number().int().nonnegative().default(0),
  rolePacksGenerated: z.number().int().nonnegative().default(0),
  inventoryPath: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type HandoffPackCheckpoint = z.infer<typeof HandoffPackCheckpointSchema>;

// ---------------------------------------------------------------------------
// Per-venture manifest config (lives under VentureManifest.handoffPack)
// ---------------------------------------------------------------------------

export const HandoffPackConfigSchema = z.object({
  /** Skip the stage entirely; default false. */
  enabled: z.boolean().default(true),
  /**
   * Which role packs to assemble. Default = all 8. Subset accepted for
   * trimmed packs. Empty array = no role packs (still renders individual
   * doc PDFs).
   */
  includeRolePacks: z
    .array(RoleSchema)
    .default([...DEFAULT_ROLE_PACK_NAMES]),
  /**
   * Free-form text appended to every footer after the standard
   * copyright. e.g. "Confidential -- Acme Corp internal use only".
   * Mirrors PdfTemplateConfig.footerConfidentialityNote so callers can
   * set it per-venture without editing the .brand/ json.
   */
  customCoverNote: z.string().default(""),
  /**
   * Tiers to exclude from rendering. e.g. ["D"] skips the ~105 pure
   * stubs for ventures that don't want the long-tail. Default empty =
   * include all tiers.
   */
  excludeTiers: z.array(TierSchema).default([]),
});
export type HandoffPackConfig = z.infer<typeof HandoffPackConfigSchema>;

// ---------------------------------------------------------------------------
// Parse helper re-exports -- the actual helpers live in parse.ts so callers
// can import the focused module if they want, but the barrel surface is the
// canonical entry point.
// ---------------------------------------------------------------------------

export {
  parseDocDescriptor,
  safeParseDocDescriptor,
  parseBrandTokens,
  safeParseBrandTokens,
  parsePdfTemplateConfig,
  safeParsePdfTemplateConfig,
  parseRolePackDescriptor,
  safeParseRolePackDescriptor,
  parseHandoffPackInventory,
  safeParseHandoffPackInventory,
  parseHandoffPackCheckpoint,
  safeParseHandoffPackCheckpoint,
  parseHandoffPackConfig,
  safeParseHandoffPackConfig,
} from "./parse.js";
