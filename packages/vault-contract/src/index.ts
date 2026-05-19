/**
 * @founder-os/vault-contract -- CLIENT-SAFE zod schemas for the Dream Vault.
 *
 * Slice 1 of the DREAM_VAULT arc. Pure contracts: enums, schemas, and inferred
 * types shared by import-core, document-extractor, image-extractor, chat-importer,
 * google-drive-importer, knowledge-extractor, project-classifier, markdown-vault,
 * and vault-runner. Zero node:* imports, zero filesystem access, zero LLM calls.
 *
 * Schema files mirror @founder-os/handoff-contract: each `*Schema` is exported
 * alongside its inferred TS type via `z.infer`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Lifecycle of an import job. */
export const ImportJobStatusSchema = z.enum([
  "queued",
  "processing",
  "needs_review",
  "committed",
  "failed",
  "cancelled",
]);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

/** Where the source originated. */
export const SourceProviderSchema = z.enum([
  "local",
  "google_drive",
  "paste",
  "manual",
]);
export type SourceProvider = z.infer<typeof SourceProviderSchema>;

/** What the user fed into the importer. */
export const SourceModeSchema = z.enum([
  "files",
  "folder",
  "drive_files",
  "drive_folder",
  "paste_text",
]);
export type SourceMode = z.infer<typeof SourceModeSchema>;

/**
 * Loose source-type taxonomy used downstream by the project-classifier prompt
 * and by the vault UI filter chips. Extractors map their detected file type
 * into one of these buckets.
 */
export const SourceTypeSchema = z.enum([
  "document",
  "image",
  "chat",
  "transcript",
  "spreadsheet",
  "code",
  "structured",
  "other",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** Result of the per-document extraction phase. */
export const ExtractionStatusSchema = z.enum([
  "pending",
  "succeeded",
  "partial",
  "failed",
  "skipped",
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/**
 * How the text was pulled. Drives the "needs OCR" handoff: a PDF with no
 * extractable text returns extractionMethod=scanned_pdf_needs_ocr and
 * import-core re-routes it through image-extractor.
 */
export const ExtractionMethodSchema = z.enum([
  "pdf_text",
  "pdf_no_text",
  "scanned_pdf_needs_ocr",
  "docx_mammoth",
  "markdown_native",
  "text_native",
  "html_native",
  "csv_native",
  "json_native",
  "image_ocr",
  "image_vision",
  "chat_chatgpt",
  "chat_claude",
  "chat_generic_markdown",
  "paste_text",
  "manual",
  "unsupported",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

/** Coarse confidence used everywhere a model or heuristic outputs a score. */
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Suggested item types the knowledge-extractor emits. */
export const ExtractedItemTypeSchema = z.enum([
  "decision",
  "task",
  "idea",
  "prompt",
  "summary",
  "brand_reference",
  "ui_reference",
  "research_finding",
  "code_snippet",
  "todo",
  "question",
  "fact",
]);
export type ExtractedItemType = z.infer<typeof ExtractedItemTypeSchema>;

/** Approval lifecycle for matches + items + notes. */
export const ReviewStatusSchema = z.enum([
  "suggested",
  "approved",
  "rejected",
  "manual",
  "unsorted",
  "imported_to_project",
  "vault_only",
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/** Vault note template kinds — drives template selection in markdown-vault. */
export const VaultNoteTypeSchema = z.enum([
  "project_index",
  "chat_summary",
  "document_summary",
  "image_note",
  "decision_log",
  "task_list",
  "prompt_pack",
  "research_note",
  "brand_reference",
  "ui_reference",
  "raw_archive",
]);
export type VaultNoteType = z.infer<typeof VaultNoteTypeSchema>;

/** Cloud provider connection state (slice 5+ surface). */
export const CloudConnectionStatusSchema = z.enum([
  "connected",
  "disconnected",
  "error",
  "expired",
]);
export type CloudConnectionStatus = z.infer<typeof CloudConnectionStatusSchema>;

// ---------------------------------------------------------------------------
// SourceDocument — one row per file/paste/chat-export ingested.
// ---------------------------------------------------------------------------

export const SourceDocumentSchema = z.object({
  id: z.string(),
  importJobId: z.string(),
  sourceType: SourceTypeSchema,
  sourceProvider: SourceProviderSchema,
  originalName: z.string(),
  mimeType: z.string().optional(),
  fileExtension: z.string().optional(),
  /** Workspace-relative path inside _vault/_import-cache/. */
  cachedOriginalPath: z.string(),
  /** sha256, lower-case hex, for cross-job dedupe. */
  contentHash: z.string(),
  /** Byte size of the cached original. */
  byteSize: z.number().int().nonnegative().optional(),
  extractionStatus: ExtractionStatusSchema,
  extractionMethod: ExtractionMethodSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  needsReview: z.boolean().default(false),
  /** ISO timestamps. */
  createdAt: z.string(),
  importedAt: z.string().optional(),
  schemaVersion: z.literal(1).default(1),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

// ---------------------------------------------------------------------------
// ImportJob — one row per user-triggered ingestion run.
// ---------------------------------------------------------------------------

export const ImportJobSchema = z.object({
  id: z.string(),
  status: ImportJobStatusSchema,
  sourceProvider: SourceProviderSchema,
  sourceMode: SourceModeSchema,
  fileCount: z.number().int().nonnegative().default(0),
  processedCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  warningCount: z.number().int().nonnegative().default(0),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  schemaVersion: z.literal(1).default(1),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

// ---------------------------------------------------------------------------
// ProjectMatch — the project-classifier's suggestion(s) per source.
// ---------------------------------------------------------------------------

export const ProjectMatchSchema = z.object({
  id: z.string(),
  sourceDocumentId: z.string(),
  /** Foreign key into ventures.id. Null when match resolves to "unsorted". */
  projectId: z.string().nullable(),
  /** Free-text suggestion when the LLM proposes a new project we don't yet have. */
  suggestedProjectName: z.string().optional(),
  confidence: ConfidenceSchema,
  reason: z.string().optional(),
  status: ReviewStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectMatch = z.infer<typeof ProjectMatchSchema>;

// ---------------------------------------------------------------------------
// ExtractedItem — atomic decisions / tasks / prompts pulled by the LLM.
// ---------------------------------------------------------------------------

export const ExtractedItemSchema = z.object({
  id: z.string(),
  sourceDocumentId: z.string(),
  /** Null when the item lives in the inbox/unsorted area. */
  projectId: z.string().nullable(),
  type: ExtractedItemTypeSchema,
  title: z.string(),
  content: z.string(),
  confidence: ConfidenceSchema,
  status: ReviewStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

// ---------------------------------------------------------------------------
// VaultNote — a rendered markdown file plus its frontmatter index entry.
// ---------------------------------------------------------------------------

/** Frontmatter written into every vault note. */
export const VaultNoteFrontmatterSchema = z.object({
  title: z.string(),
  sourceDocumentId: z.string(),
  projectSlug: z.string().nullable(),
  noteType: VaultNoteTypeSchema,
  tags: z.array(z.string()).default([]),
  itemIds: z.array(z.string()).default([]),
  confidence: ConfidenceSchema.optional(),
  createdAt: z.string(),
});
export type VaultNoteFrontmatter = z.infer<typeof VaultNoteFrontmatterSchema>;

export const VaultNoteSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  sourceDocumentId: z.string(),
  title: z.string(),
  noteType: VaultNoteTypeSchema,
  /** Workspace-relative path. */
  markdownPath: z.string(),
  tags: z.array(z.string()).default([]),
  status: ReviewStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VaultNote = z.infer<typeof VaultNoteSchema>;

// ---------------------------------------------------------------------------
// Source-side payloads emitted by extractors.
// ---------------------------------------------------------------------------

/** Output of the document-extractor for a single source doc. */
export const SourceExtractionSchema = z.object({
  id: z.string(),
  sourceDocumentId: z.string(),
  extractedTextPath: z.string().optional(),
  extractedMarkdownPath: z.string().optional(),
  summary: z.string().optional(),
  language: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type SourceExtraction = z.infer<typeof SourceExtractionSchema>;

/** Output of the image-extractor. */
export const SourceImageSchema = z.object({
  id: z.string(),
  sourceDocumentId: z.string(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  ocrText: z.string().optional(),
  visionSummary: z.string().optional(),
  detectedLayout: z.unknown().optional(),
  confidence: ConfidenceSchema.optional(),
  createdAt: z.string(),
});
export type SourceImage = z.infer<typeof SourceImageSchema>;

// ---------------------------------------------------------------------------
// Cloud + provenance bookkeeping (slice 5 will populate these properly).
// ---------------------------------------------------------------------------

export const CloudConnectionSchema = z.object({
  id: z.string(),
  provider: SourceProviderSchema,
  accountEmail: z.string(),
  connectionStatus: CloudConnectionStatusSchema,
  /**
   * Opaque keychain key, NOT the raw OAuth token. Tokens live in the OS
   * keychain via the Rust side (keyring crate); this string is only how
   * the renderer asks the Rust side to use them.
   */
  tokenReference: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type CloudConnection = z.infer<typeof CloudConnectionSchema>;

/** Per-file provenance row inside an import job (one per ingested file). */
export const ImportSourceSchema = z.object({
  id: z.string(),
  importJobId: z.string(),
  sourceType: SourceTypeSchema,
  provider: SourceProviderSchema,
  externalId: z.string().optional(),
  externalName: z.string(),
  externalMimeType: z.string().optional(),
  externalPath: z.string().optional(),
  externalUrl: z.string().optional(),
  /** Workspace-relative path inside _vault/_import-cache/. */
  localCachedPath: z.string(),
  hash: z.string(),
  importedAt: z.string(),
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;
