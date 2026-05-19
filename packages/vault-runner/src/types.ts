/**
 * Slice 8 -- shared types for the Dream Vault runner.
 *
 * CLIENT-SAFE -- only re-exports types from sibling packages plus a few
 * port shapes the runner uses to delegate to the slice-3/4/6/7
 * extractors. Filesystem touch points live behind ports so the
 * renderer can pass Tauri-command-backed implementations and tests can
 * pass in-memory stubs.
 */
import type {
  Confidence,
  ExtractedItem,
  ImportJob,
  ProjectMatch,
  SourceDocument,
  VaultNoteFrontmatter,
  VaultNoteType,
} from "@founder-os/vault-contract";
import type { ChatConversation, ParsedChat } from "@founder-os/chat-importer";
import type { ExtractionResult } from "@founder-os/document-extractor";
import type {
  ImageExtractionResult,
  OcrEngine,
  VisionCallLlm,
} from "@founder-os/image-extractor";
import type { ImportJobStore, ImportLogger, ProgressEmit } from "@founder-os/import-core";
import type {
  KnowledgeCallLlm,
  KnowledgeExtractionResult,
} from "@founder-os/knowledge-extractor";
import type { VaultFsPort } from "@founder-os/markdown-vault";
import type {
  ClassifierCallLlm,
  ClassifyDocumentResult,
  ProjectCandidate,
} from "@founder-os/project-classifier";

// ---------------------------------------------------------------------------
// Extractor ports -- the runner delegates to these so the runner package
// stays free of node:* imports + can be tested with stubs.
// ---------------------------------------------------------------------------

/** Input every extractor port receives. */
export type ExtractorPortInput = {
  doc: SourceDocument;
  /** Absolute path the runner has resolved from `doc.cachedOriginalPath`. */
  cachedAbsolutePath: string;
  workspaceRoot: string;
};

/**
 * Document extractor port: dispatches to pdf/docx/md/text/html/csv/json
 * extractors based on `doc.fileExtension` / `doc.mimeType` and returns
 * the normalised ExtractionResult envelope.
 */
export type DocumentExtractorPort = (
  input: ExtractorPortInput
) => Promise<ExtractionResult>;

/**
 * Image extractor port: returns dimensions + optional OCR + optional
 * vision summary. The runner injects the OcrEngine + VisionCallLlm via
 * the runner opts; the port just reads bytes and dispatches.
 */
export type ImageExtractorPort = (
  input: ExtractorPortInput & {
    ocrEngine?: OcrEngine;
    visionCallLlm?: VisionCallLlm;
  }
) => Promise<ImageExtractionResult>;

/**
 * Chat extractor port: reads bytes off disk and returns the normalised
 * ParsedChat envelope. The runner inspects `doc.mimeType` to route
 * between chatgpt / claude / generic / paste parsers.
 */
export type ChatExtractorPort = (
  input: ExtractorPortInput
) => Promise<ParsedChat>;

// ---------------------------------------------------------------------------
// Runner opts + result
// ---------------------------------------------------------------------------

export type VaultRunnerOpts = {
  /** The import job already advanced to `needs_review` by processImportJob. */
  job: ImportJob;
  /** Sources staged by processImportJob -- one row per ingested file. */
  sources: SourceDocument[];
  workspaceRoot: string;
  /** Resolves a workspace-relative cached path to an absolute path. */
  resolveCachedPath: (workspaceRelativePath: string) => string;
  /** Candidate ventures the classifier scores against. Empty = always unsorted. */
  candidates: ProjectCandidate[];

  extractDocument: DocumentExtractorPort;
  extractImage: ImageExtractorPort;
  extractChat: ChatExtractorPort;

  /** Same callable for both classifier + knowledge-extractor. */
  callLlm?: KnowledgeCallLlm & ClassifierCallLlm;
  ocrEngine?: OcrEngine;
  visionCallLlm?: VisionCallLlm;

  /** Used by finalize() to actually write vault notes to disk. */
  vaultFs: VaultFsPort;
  /**
   * Optional SQLite-backed import-job store. When supplied, `finalize()`
   * calls `commitImportJob` which advances the job row to "committed".
   * When absent, the runner emits a warning and leaves status-flip to
   * the caller (handy in unit tests).
   */
  store?: ImportJobStore;
  logger: ImportLogger;
  emit?: ProgressEmit;

  /** Override for deterministic test output. */
  nowFn?: () => string;
  /** Stable run id; defaults to a generated id. */
  runId?: string;
};

/** Per-source per-phase result the runner aggregates into VaultRunResult. */
export type VaultSourceProcessing = {
  source: SourceDocument;
  /** Markdown extracted from the source (empty when extraction failed). */
  markdown: string;
  /** Short summary fed to the classifier + knowledge prompts. */
  summary?: string;
  extraction:
    | { kind: "document"; result: ExtractionResult }
    | { kind: "image"; result: ImageExtractionResult }
    | { kind: "chat"; result: ParsedChat }
    | { kind: "skipped" }
    | { kind: "failed"; error: string };
  classification?: ClassifyDocumentResult;
  knowledge?: KnowledgeExtractionResult;
  drafts: VaultNoteDraft[];
};

/**
 * Draft vault note the runner produced. Held in-memory until the human
 * reviewer approves the import via finalize(). Each draft can be
 * routed to a venture-slug or remain unsorted at finalize time.
 */
export type VaultNoteDraft = {
  noteId: string;
  noteType: VaultNoteType;
  sourceDocumentId: string;
  /** Suggested project slug from the highest-confidence ProjectMatch. */
  suggestedVentureSlug: string | null;
  title: string;
  /** Pre-rendered preview using the suggested slug; safe to display. */
  previewContent: string;
  previewFrontmatter: VaultNoteFrontmatter;
  itemIds: string[];
  tags: string[];
  confidence?: Confidence;
  /** Held so finalize() can re-render with possibly-different slug. */
  variables: Record<string, unknown>;
};

export type VaultRunResult = {
  jobId: string;
  /** "needs_review" on success; "failed" if the runner threw before phase 9. */
  status: "needs_review" | "failed";
  perSource: VaultSourceProcessing[];
  matches: Record<string, ProjectMatch[]>;
  items: Record<string, ExtractedItem[]>;
  drafts: VaultNoteDraft[];
  logs: VaultLogEntry[];
  /** Aggregated warnings the UI can show on the review screen. */
  warnings: string[];
  /** Set when status === "failed". */
  error?: { code: string; message: string };
};

export type VaultLogLevel = "info" | "warn" | "error";

export type VaultLogEntry = {
  timestamp: string;
  level: VaultLogLevel;
  message: string;
  data?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Finalize -- the post-review commit path.
// ---------------------------------------------------------------------------

/**
 * Per-source approval the reviewer makes at the gate. The runner uses
 * this to pick the venture-slug for each draft and to skip drafts the
 * reviewer rejected.
 */
export type VaultSourceApproval = {
  sourceDocumentId: string;
  /** Venture slug to route this source's notes to, or null for unsorted. */
  ventureSlug: string | null;
  /** Draft note ids the reviewer wants written. Defaults to all drafts. */
  acceptedNoteIds?: string[];
};

export type VaultFinalizeInput = {
  /** Reviewer's per-source decisions. Missing source = drop everything. */
  approvals: VaultSourceApproval[];
  /** ISO timestamp threaded to commit + note frontmatter. */
  now: string;
};

export type VaultFinalizeResult = {
  jobId: string;
  status: "committed" | "failed";
  notesWritten: Array<{
    noteId: string;
    sourceDocumentId: string;
    ventureSlug: string | null;
    absolutePath: string;
    relativePath: string;
  }>;
  skippedCount: number;
  logs: VaultLogEntry[];
  warnings: string[];
  error?: { code: string; message: string };
};

export class VaultRunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VaultRunnerError";
  }
}

// Re-export so callers only need one import:
export type {
  ChatConversation,
  ClassifyDocumentResult,
  ExtractionResult,
  ImageExtractionResult,
  ImportJob,
  KnowledgeExtractionResult,
  ParsedChat,
  ProjectCandidate,
  SourceDocument,
  VaultFsPort,
};
