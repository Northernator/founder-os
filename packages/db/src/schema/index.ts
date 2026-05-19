import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ventures table: lightweight metadata only. Canonical venture config
 * lives in venture.yaml on disk.
 */
export const ventures = sqliteTable(
  "ventures",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    stage: text("stage").notNull(),
    rootPath: text("root_path").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    slugIdx: index("ventures_slug_idx").on(t.slug),
    stageIdx: index("ventures_stage_idx").on(t.stage),
  })
);

/**
 * Artifacts index: filesystem is source of truth; this table is for fast queries.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    type: text("type").notNull(),
    path: text("path").notNull(),
    hash: text("hash"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    derivedFromJson: text("derived_from_json").notNull().default("[]"),
    tagsJson: text("tags_json").notNull().default("[]"),
  },
  (t) => ({
    ventureIdx: index("artifacts_venture_idx").on(t.ventureId),
    typeIdx: index("artifacts_type_idx").on(t.type),
  })
);

/**
 * Pipeline runs: one row per handoff bundle lifecycle.
 */
export const runs = sqliteTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    ventureIdx: index("runs_venture_idx").on(t.ventureId),
    statusIdx: index("runs_status_idx").on(t.status),
  })
);

/**
 * Audit findings: joined to runs.
 */
export const auditFindings = sqliteTable(
  "audit_findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    ventureId: text("venture_id").notNull(),
    ruleId: text("rule_id").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    filePath: text("file_path"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    runIdx: index("findings_run_idx").on(t.runId),
    severityIdx: index("findings_severity_idx").on(t.severity),
  })
);

/**
 * Chat messages: venture-scoped. Full transcripts also live on disk as JSONL.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    threadIdx: index("chat_thread_idx").on(t.threadId),
  })
);

/**
 * Tasks: venture-scoped todo items; often created by pipeline steps (e.g. "file trademark").
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ventureId: text("venture_id")
      .notNull()
      .references(() => ventures.id),
    title: text("title").notNull(),
    status: text("status").notNull(),
    stage: text("stage"),
    dueAt: text("due_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    ventureIdx: index("tasks_venture_idx").on(t.ventureId),
    statusIdx: index("tasks_status_idx").on(t.status),
  })
);

// ---------------------------------------------------------------------------
// Dream Vault tables (slice 1 of DREAM_VAULT_MODULE arc).
// Filesystem under <workspace>/_vault/ holds the canonical artefacts; these
// tables are the lightweight index the UI polls.
// ---------------------------------------------------------------------------

/** Import-job lifecycle row -- one per user-triggered ingestion run. */
export const vaultImportJobs = sqliteTable(
  "vault_import_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    sourceProvider: text("source_provider").notNull(),
    sourceMode: text("source_mode").notNull(),
    fileCount: integer("file_count").notNull().default(0),
    processedCount: integer("processed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    statusIdx: index("vault_import_jobs_status_idx").on(t.status),
    createdIdx: index("vault_import_jobs_created_idx").on(t.createdAt),
  })
);

/** One row per ingested source (file, paste, chat export). */
export const vaultSourceDocuments = sqliteTable(
  "vault_source_documents",
  {
    id: text("id").primaryKey(),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => vaultImportJobs.id),
    sourceType: text("source_type").notNull(),
    sourceProvider: text("source_provider").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    fileExtension: text("file_extension"),
    cachedOriginalPath: text("cached_original_path").notNull(),
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size"),
    extractionStatus: text("extraction_status").notNull(),
    extractionMethod: text("extraction_method"),
    confidence: text("confidence"),
    needsReview: integer("needs_review").notNull().default(0),
    createdAt: text("created_at").notNull(),
    importedAt: text("imported_at"),
  },
  (t) => ({
    jobIdx: index("vault_source_documents_job_idx").on(t.importJobId),
    hashIdx: index("vault_source_documents_hash_idx").on(t.contentHash),
    statusIdx: index("vault_source_documents_status_idx").on(t.extractionStatus),
  })
);

/** Per-document extracted-text payload (document-extractor output). */
export const vaultSourceExtractions = sqliteTable(
  "vault_source_extractions",
  {
    id: text("id").primaryKey(),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => vaultSourceDocuments.id),
    extractedTextPath: text("extracted_text_path"),
    extractedMarkdownPath: text("extracted_markdown_path"),
    summary: text("summary"),
    language: text("language"),
    confidence: text("confidence"),
    warningsJson: text("warnings_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    docIdx: index("vault_source_extractions_doc_idx").on(t.sourceDocumentId),
  })
);

/** Per-image OCR/vision payload (image-extractor output). */
export const vaultSourceImages = sqliteTable(
  "vault_source_images",
  {
    id: text("id").primaryKey(),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => vaultSourceDocuments.id),
    width: integer("width"),
    height: integer("height"),
    ocrText: text("ocr_text"),
    visionSummary: text("vision_summary"),
    detectedLayoutJson: text("detected_layout_json"),
    confidence: text("confidence"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    docIdx: index("vault_source_images_doc_idx").on(t.sourceDocumentId),
  })
);

/** project-classifier suggestion(s) -- many-to-one against source documents. */
export const vaultProjectMatches = sqliteTable(
  "vault_project_matches",
  {
    id: text("id").primaryKey(),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => vaultSourceDocuments.id),
    /** Nullable foreign key into ventures.id (null == "unsorted"). */
    projectId: text("project_id").references(() => ventures.id),
    suggestedProjectName: text("suggested_project_name"),
    confidence: text("confidence").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    docIdx: index("vault_project_matches_doc_idx").on(t.sourceDocumentId),
    projectIdx: index("vault_project_matches_project_idx").on(t.projectId),
    statusIdx: index("vault_project_matches_status_idx").on(t.status),
  })
);

/** knowledge-extractor output -- atomic decisions/tasks/prompts/etc. */
export const vaultExtractedItems = sqliteTable(
  "vault_extracted_items",
  {
    id: text("id").primaryKey(),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => vaultSourceDocuments.id),
    projectId: text("project_id").references(() => ventures.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    confidence: text("confidence").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    docIdx: index("vault_extracted_items_doc_idx").on(t.sourceDocumentId),
    projectIdx: index("vault_extracted_items_project_idx").on(t.projectId),
    typeIdx: index("vault_extracted_items_type_idx").on(t.type),
    statusIdx: index("vault_extracted_items_status_idx").on(t.status),
  })
);

/** Rendered vault notes -- markdown lives on disk, this is the index. */
export const vaultNotes = sqliteTable(
  "vault_notes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => ventures.id),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => vaultSourceDocuments.id),
    title: text("title").notNull(),
    noteType: text("note_type").notNull(),
    markdownPath: text("markdown_path").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    projectIdx: index("vault_notes_project_idx").on(t.projectId),
    docIdx: index("vault_notes_doc_idx").on(t.sourceDocumentId),
    typeIdx: index("vault_notes_type_idx").on(t.noteType),
  })
);

/**
 * Cloud connection metadata. tokenReference is an opaque OS-keychain key --
 * raw OAuth tokens NEVER live in SQLite; they are managed by the Rust side.
 */
export const vaultCloudConnections = sqliteTable(
  "vault_cloud_connections",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    accountEmail: text("account_email").notNull(),
    connectionStatus: text("connection_status").notNull(),
    tokenReference: text("token_reference").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    providerIdx: index("vault_cloud_connections_provider_idx").on(t.provider),
  })
);

/** Per-file provenance row inside an import job. */
export const vaultImportSources = sqliteTable(
  "vault_import_sources",
  {
    id: text("id").primaryKey(),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => vaultImportJobs.id),
    sourceType: text("source_type").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    externalName: text("external_name").notNull(),
    externalMimeType: text("external_mime_type"),
    externalPath: text("external_path"),
    externalUrl: text("external_url"),
    localCachedPath: text("local_cached_path").notNull(),
    hash: text("hash").notNull(),
    importedAt: text("imported_at").notNull(),
  },
  (t) => ({
    jobIdx: index("vault_import_sources_job_idx").on(t.importJobId),
    hashIdx: index("vault_import_sources_hash_idx").on(t.hash),
  })
);

export type DbSchema = {
  ventures: typeof ventures;
  artifacts: typeof artifacts;
  runs: typeof runs;
  auditFindings: typeof auditFindings;
  chatMessages: typeof chatMessages;
  tasks: typeof tasks;
  vaultImportJobs: typeof vaultImportJobs;
  vaultSourceDocuments: typeof vaultSourceDocuments;
  vaultSourceExtractions: typeof vaultSourceExtractions;
  vaultSourceImages: typeof vaultSourceImages;
  vaultProjectMatches: typeof vaultProjectMatches;
  vaultExtractedItems: typeof vaultExtractedItems;
  vaultNotes: typeof vaultNotes;
  vaultCloudConnections: typeof vaultCloudConnections;
  vaultImportSources: typeof vaultImportSources;
};
