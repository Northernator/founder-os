/**
 * run-vault-import.ts -- desktop adoption helper for the Dream Vault arc.
 *
 * Mirrors the shape of run-media-stage.ts:
 *   1. Resolve the subscription-first callLlm via buildPipelineLlmCaller
 *      (subscription-mode CLIs preferred per project policy; falls back
 *      to API keys when those aren't wired).
 *   2. Construct the in-process VaultStageRunner with browser-side
 *      extractor ports (document/image/chat) that bridge to the
 *      filesystem via Tauri commands.
 *   3. Run phases 1-9 -- the runner stops at "needs_review" and returns
 *      the draft notes for the slice-10 review UI to consume.
 *
 * Slice 9 scope: this file ships the runner + the UI plumbing. The
 * Tauri-side commands (`vault_stage_file`, `vault_hash_file`,
 * `vault_read_file_bytes`, `vault_extract_pdf`, `vault_extract_docx`)
 * are stubbed here so the renderer compiles + types check; the Rust
 * side lands alongside slice 11's Drive picker / slice 12's wiring.
 * Every Tauri invoke is wrapped so the helper degrades gracefully when
 * a command isn't registered yet -- the runner falls back to
 * deterministic offline behaviour rather than blowing up the import.
 *
 * Persistence: slice 9 keeps the job + sources in-memory only. The
 * Rust-side SQLite migration (slice 1) already created the tables, but
 * no IPC commands surface them to the renderer yet. The progress
 * screen reads its state directly from this helper's onProgress
 * callbacks instead of polling the DB row.
 */
import {
  type ChatConversation,
  type ParsedChat,
  parseChatGptExport,
  parseClaudeJsonExport,
  parseClaudeMarkdownExport,
  parseGenericTranscript,
  parsePastedText,
} from "@founder-os/chat-importer";
import {
  type ExtractionResult,
  extractCsv,
  extractHtml,
  extractJson,
  extractMarkdown,
  extractText,
} from "@founder-os/document-extractor";
import {
  type ImageExtractionResult,
  type OcrEngine,
  createNoopOcrEngine,
  extractImage,
} from "@founder-os/image-extractor";
import {
  type ImportJobStore,
  type ImportLogger,
  defaultSourceIdFactory,
} from "@founder-os/import-core";
import { VAULT_TEMPLATE_VERSION, createMemoryFsPort } from "@founder-os/markdown-vault";
import type { ProjectCandidate } from "@founder-os/project-classifier";
import type {
  ImportJob,
  ImportJobStatus,
  SourceDocument,
  SourceMode,
  SourceProvider,
} from "@founder-os/vault-contract";
import {
  type ChatExtractorPort,
  type DocumentExtractorPort,
  type ImageExtractorPort,
  type VaultFinalizeInput,
  type VaultFinalizeResult,
  type VaultRunResult,
  VaultStageRunner,
} from "@founder-os/vault-runner";
import { invoke } from "@tauri-apps/api/core";
import { buildPipelineLlmCaller } from "../../lib/pipeline-llm.js";
import { buildDriveClient, DriveCommandNotWiredError } from "./drive-client.js";

// ---------------------------------------------------------------------------
// Tauri command envelopes (slice 9 stubs; Rust side lands later).
// Every `safeInvoke<T>` wrapper catches the "command not registered" error
// and returns `null` so the helper degrades to deterministic offline mode.
// ---------------------------------------------------------------------------

/**
 * Returns true when `err` is Tauri's "command not registered" error
 * for `command`, NOT a legitimate runtime error returned BY a
 * registered command.
 *
 * The previous predicate was `/not found|not registered|unknown command|
 * isn't defined/i.test(msg) || msg.includes(command)`. The plain
 * `/not found/i` matched legitimate Rust errors like
 * `"source file not found: C:\\path\\to\\file"` from `vault_fs.rs`'s
 * `vault_stage_file` -- which swallowed the real "bad path" error
 * and made the runner silently degrade to the synthetic stub-hash
 * fallback. The user couldn't see why imports were producing
 * stub-hashed sources because the diagnostic was eaten.
 *
 * Tighter rule: BOTH the command name AND a not-registered
 * indicator must appear in the message. Tauri 2 emits messages
 * like:
 *   `command \`vault_stage_file\` not found`
 *   `unknown command vault_stage_file`
 *   `command vault_stage_file is not allowed`
 * The command name always appears in the phrase. Legitimate runtime
 * errors from a registered command (the case we want to bubble up)
 * either omit the command name entirely or word it without the
 * not-registered indicator.
 */
function isCommandNotRegisteredError(err: unknown, command: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.toLowerCase().includes(command.toLowerCase())) return false;
  return (
    /\bnot\s+(found|registered|allowed|defined)\b/i.test(message) ||
    /\bunknown\s+command\b/i.test(message) ||
    /\bisn'?t\s+defined\b/i.test(message)
  );
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (isCommandNotRegisteredError(err, command)) {
      console.warn(`[run-vault-import] Tauri command "${command}" not registered yet -- using stub`);
      return null;
    }
    // Legitimate runtime error from a registered command. Surface it
    // to DevTools so the founder can see what actually went wrong --
    // the previous over-matching predicate hid these completely.
    console.error(`[run-vault-import] ${command} failed:`, err);
    throw err;
  }
}

/**
 * Read a workspace-cached file's bytes via Tauri. Returns null when the
 * command isn't registered (slice 9 stub path) so the runner falls back
 * to deterministic behaviour rather than crashing.
 */
async function readCachedBytes(absolutePath: string): Promise<Uint8Array | null> {
  const result = await safeInvoke<number[] | null>("vault_read_file_bytes", { absolutePath });
  if (!result) return null;
  return new Uint8Array(result);
}

/** Decode a Uint8Array as UTF-8. Used by the text-format extractors. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// Extractor ports -- browser-side dispatch into the pure
// @founder-os/document-extractor / image-extractor / chat-importer entries.
// ---------------------------------------------------------------------------

const documentPort: DocumentExtractorPort = async ({ doc, cachedAbsolutePath }) => {
  const bytes = await readCachedBytes(cachedAbsolutePath);
  if (!bytes) {
    return {
      markdown: "",
      summary: undefined,
      warnings: ["vault_read_file_bytes Tauri command not wired yet (slice 9 stub)"],
      confidence: "low",
      extractionMethod: "unsupported",
      needsReview: true,
    } satisfies ExtractionResult;
  }
  const text = decodeUtf8(bytes);
  const ext = (doc.fileExtension ?? "").toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return extractMarkdown({ text });
    case "txt":
      return extractText({ text });
    case "htm":
    case "html":
      return extractHtml({ text });
    case "csv":
      return extractCsv({ text });
    case "json":
      return extractJson({ text });
    case "pdf": {
      // Slice 9 stub: real PDF extraction needs pdfjs-dist via a Tauri
      // command (pdfjs-dist pulls in node:fs internals; the renderer
      // cannot import it directly per the biome rule). Route through
      // the Tauri command when wired; otherwise mark needs-review.
      const ipc = await safeInvoke<{ markdown: string; pageCount: number } | null>(
        "vault_extract_pdf",
        { absolutePath: cachedAbsolutePath }
      );
      if (ipc) {
        return {
          markdown: ipc.markdown,
          summary: undefined,
          warnings: [],
          confidence: ipc.markdown.length > 0 ? "medium" : "low",
          extractionMethod: ipc.markdown.length > 0 ? "pdf_text" : "scanned_pdf_needs_ocr",
          pageCount: ipc.pageCount,
          needsReview: ipc.markdown.length === 0,
        };
      }
      return {
        markdown: "",
        summary: undefined,
        warnings: ["vault_extract_pdf Tauri command not wired yet (slice 9 stub)"],
        confidence: "low",
        extractionMethod: "unsupported",
        needsReview: true,
      };
    }
    case "docx": {
      const ipc = await safeInvoke<{ markdown: string; warnings: string[] } | null>(
        "vault_extract_docx",
        { absolutePath: cachedAbsolutePath }
      );
      if (ipc) {
        return {
          markdown: ipc.markdown,
          summary: undefined,
          warnings: ipc.warnings,
          confidence: ipc.markdown.length > 0 ? "medium" : "low",
          extractionMethod: "docx_mammoth",
          needsReview: ipc.markdown.length === 0,
        };
      }
      return {
        markdown: "",
        summary: undefined,
        warnings: ["vault_extract_docx Tauri command not wired yet (slice 9 stub)"],
        confidence: "low",
        extractionMethod: "unsupported",
        needsReview: true,
      };
    }
    default:
      return {
        markdown: "",
        summary: undefined,
        warnings: [`unsupported extension: ${ext || "(none)"}`],
        confidence: "low",
        extractionMethod: "unsupported",
        needsReview: true,
      };
  }
};

const imagePort: ImageExtractorPort = async ({ cachedAbsolutePath, ocrEngine, visionCallLlm, doc }) => {
  const bytes = await readCachedBytes(cachedAbsolutePath);
  if (!bytes) {
    return {
      pixelFormat: "unknown",
      warnings: ["vault_read_file_bytes Tauri command not wired yet (slice 9 stub)"],
      confidence: "low",
      extractionMethod: "unsupported",
      needsReview: true,
    } satisfies ImageExtractionResult;
  }
  const engine: OcrEngine = ocrEngine ?? createNoopOcrEngine();
  return extractImage({
    buffer: bytes,
    ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
    ocrEngine: engine,
    ...(visionCallLlm ? { visionCallLlm } : {}),
  });
};

/**
 * Cheap pre-parse sniff to pick the right JSON chat parser without
 * fully parsing the file. Operates on the first 4 KiB only -- chat
 * exports can be 80+ MB and a full JSON.parse just to discriminate
 * shape would dominate the import latency.
 *
 * Discriminators (top-level field names that appear early in every
 * canonical export shape we support):
 *   - "chat_messages"            -> Claude JSON (per-conversation field)
 *   - "mapping" + "current_node" -> ChatGPT (per-conversation fields)
 *
 * Order: Claude first because `"chat_messages"` is more specific
 * than `"mapping"` (which appears in plenty of unrelated JSON shapes).
 *
 * Returns "unknown" when neither signal is present; the caller then
 * treats the JSON as a paste blob via parsePastedText.
 */
function sniffJsonChatShape(text: string): "claude" | "chatgpt" | "unknown" {
  const sample = text.slice(0, 4096);
  if (sample.includes('"chat_messages"')) return "claude";
  if (sample.includes('"mapping"') && sample.includes('"current_node"')) return "chatgpt";
  return "unknown";
}

const chatPort: ChatExtractorPort = async ({ doc, cachedAbsolutePath }) => {
  const bytes = await readCachedBytes(cachedAbsolutePath);
  if (!bytes) {
    return {
      extractionMethod: "manual",
      conversations: [],
      warnings: ["vault_read_file_bytes Tauri command not wired yet (slice 9 stub)"],
    } satisfies ParsedChat;
  }
  const text = decodeUtf8(bytes);
  const ext = (doc.fileExtension ?? "").toLowerCase();
  if (ext === "json") {
    // Deterministic dispatch. The previous try/catch cascade assumed
    // parseChatGptExport would THROW on a Claude export, but Claude
    // is also an array -- so the outer Array.isArray check passed,
    // every element failed `parseOneConversation` for missing
    // `mapping`, and the per-item failures became warnings on a
    // returned envelope with `conversations: []`. The cascade never
    // fell through, real Claude content silently dropped.
    //
    // The all-bad guards added to parseChatGptExport +
    // parseClaudeJsonExport restore throw-based fallback for the
    // legacy cascade, but the sniff below avoids the throw round-trip
    // entirely on the happy path.
    const shape = sniffJsonChatShape(text);
    let parsed: ParsedChat;
    if (shape === "claude") {
      parsed = parseClaudeJsonExport(text);
    } else if (shape === "chatgpt") {
      parsed = parseChatGptExport(text);
    } else {
      parsed = parsePastedText({ text });
    }
    if (parsed.conversations.length === 0) {
      console.warn(
        `[run-vault-import] chat parser produced 0 conversations for "${doc.originalName}" (sniff: ${shape}). Inspect the file's top 4 KiB for "chat_messages" / "mapping" / "current_node" to debug.`,
        { warnings: parsed.warnings },
      );
    }
    return parsed;
  }
  if (ext === "md" || ext === "markdown") {
    return parseClaudeMarkdownExport(text);
  }
  // Plain text -- run the generic transcript detector.
  return parseGenericTranscript({ text });
};

// ---------------------------------------------------------------------------
// SQLite-backed ImportJobStore (Rust IPC arc slice 1).
//
// Each method invokes the matching Tauri command in apps/founder-desktop/
// src-tauri/src/vault.rs. The factory probes vault_get_job() at construction
// with a sentinel id; if the command isn't registered yet (Rust side not
// rebuilt with slice-1 changes), the factory returns null and the helper
// falls back to createMemoryJobStore() so the renderer keeps working.
//
// The probe-and-fail-once approach is preferred over catching per-method
// because we want a single decision point ("is the Rust side ready?")
// rather than per-call branching that could end up in a half-persisted
// state.
// ---------------------------------------------------------------------------

async function createSqliteJobStore(): Promise<ImportJobStore | null> {
  // Probe with a sentinel id. If vault_get_job is registered, we get
  // back null (no such row) and know the rest of the surface is ready.
  // If it's not registered, safeInvoke returns null and we treat that
  // as "Rust slice 1 hasn't shipped on this build" — caller falls back
  // to memory store.
  const probe = await safeInvoke<ImportJob | null>("vault_get_job", {
    jobId: "__vault_probe__",
  });
  // safeInvoke's `null` covers both "row not found" and "command not
  // registered". To disambiguate, we round-trip a known-empty list
  // call; vault_list_jobs returns [] when registered and the table is
  // empty, vs null when not registered.
  const liveProbe = await safeInvoke<ImportJob[] | null>("vault_list_jobs", {
    limit: 0,
  });
  if (liveProbe === null && probe === null) {
    // Both safeInvokes hit the "command not registered" warn-and-null
    // path. Memory store it is.
    return null;
  }

  const now = () => new Date().toISOString();
  return {
    insertJob: async (job) => {
      await invoke<void>("vault_create_job", { job });
    },
    updateJobStatus: async (jobId, status, errorMessage) => {
      await invoke<void>("vault_update_job_status", {
        jobId,
        status,
        errorMessage: errorMessage ?? null,
        now: now(),
      });
    },
    getJob: async (jobId) => {
      const row = await invoke<ImportJob | null>("vault_get_job", { jobId });
      return row;
    },
    incrementCounts: async (jobId, delta) => {
      await invoke<void>("vault_increment_job_counts", {
        jobId,
        delta: {
          processedCount: delta.processedCount ?? null,
          failedCount: delta.failedCount ?? null,
          warningCount: delta.warningCount ?? null,
          fileCount: delta.fileCount ?? null,
        },
        now: now(),
      });
    },
    insertSource: async (doc) => {
      await invoke<void>("vault_insert_source", { doc });
    },
    listSourcesForJob: async (jobId) => {
      const rows = await invoke<SourceDocument[]>("vault_list_sources_for_job", {
        jobId,
      });
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory ImportJobStore -- the slice-9 fallback. Used when
// createSqliteJobStore() returns null (Rust side not yet wired) and as
// the test stub.
// ---------------------------------------------------------------------------

function createMemoryJobStore(initial: ImportJob): ImportJobStore & {
  jobs: Map<string, ImportJob>;
  sources: Map<string, SourceDocument>;
  status: () => ImportJobStatus;
} {
  const jobs = new Map<string, ImportJob>([[initial.id, { ...initial }]]);
  const sources = new Map<string, SourceDocument>();
  return {
    jobs,
    sources,
    status: () => jobs.get(initial.id)?.status ?? initial.status,
    insertJob: async (job) => {
      jobs.set(job.id, { ...job });
    },
    updateJobStatus: async (jobId, status, errorMessage) => {
      const existing = jobs.get(jobId);
      if (!existing) return;
      const next: ImportJob = { ...existing, status };
      if (errorMessage !== undefined) next.errorMessage = errorMessage;
      jobs.set(jobId, next);
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    incrementCounts: async (jobId, delta) => {
      const existing = jobs.get(jobId);
      if (!existing) return;
      jobs.set(jobId, {
        ...existing,
        processedCount: existing.processedCount + (delta.processedCount ?? 0),
        failedCount: existing.failedCount + (delta.failedCount ?? 0),
        warningCount: existing.warningCount + (delta.warningCount ?? 0),
        fileCount: existing.fileCount + (delta.fileCount ?? 0),
      });
    },
    insertSource: async (doc) => {
      sources.set(doc.id, doc);
    },
    listSourcesForJob: async (jobId) => {
      return Array.from(sources.values()).filter((s) => s.importJobId === jobId);
    },
  };
}

function createImportLogger(prefix: string): ImportLogger {
  return {
    info: (event, fields) => console.info(`[vault-import:${prefix}]`, event, fields ?? {}),
    warn: (event, fields) => console.warn(`[vault-import:${prefix}]`, event, fields ?? {}),
    error: (event, fields) => console.error(`[vault-import:${prefix}]`, event, fields ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type VaultImportSourceInput = {
  /** Tauri-side absolute path to the original file. */
  absolutePath: string;
  originalName: string;
  fileExtension?: string;
  mimeType?: string;
  /** "document" | "image" | "chat" | "transcript" | "spreadsheet" | "code" | "structured" | "other". */
  sourceType: SourceDocument["sourceType"];
  byteSize?: number;
};

export type RunVaultImportOpts = {
  workspaceRoot: string;
  provider: SourceProvider;
  mode: SourceMode;
  sources: VaultImportSourceInput[];
  /** Venture list the project-classifier scores against. */
  candidates: ProjectCandidate[];
  /** Per-venture id used to pick the active LLM provider. */
  ventureId?: string;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** When supplied, used for stable test output; defaults to `new Date()`. */
  nowFn?: () => string;
};

export type ProgressEvent =
  | { kind: "job_created"; jobId: string }
  | { kind: "phase"; message: string; data?: Record<string, unknown> }
  | { kind: "source_staged"; sourceId: string; originalName: string }
  | { kind: "source_failed"; sourceId: string; originalName: string; error: string }
  | { kind: "ready_for_review"; jobId: string };

export type RunVaultImportResult = {
  job: ImportJob;
  run: VaultRunResult;
  /**
   * The live runner instance. Set when the result came from
   * `runVaultImport()` running phases 1-9 in this session. Absent when
   * the result was reconstructed from SQLite by the resumable-imports
   * boot hydration -- a resumed entry has no live runner because the
   * extractor ports + LLM caller + fs port are all session-bound. The
   * review screen never reads this field; it's exposed for callers
   * that want to introspect the in-session runner state.
   */
  runner?: VaultStageRunner;
  /** True iff a callLlm was wired via the desktop's pipeline-llm. */
  llmConfigured: boolean;
  /**
   * Finalize callback the review UI calls once the founder approves the
   * drafts. The runner is the source of truth -- it keeps the lastRun
   * state internally and writes notes via the injected fs port.
   */
  finalize: (input: VaultFinalizeInput) => Promise<VaultFinalizeResult>;
};

export async function runVaultImport(opts: RunVaultImportOpts): Promise<RunVaultImportResult> {
  const now = opts.nowFn ?? (() => new Date().toISOString());
  const startedAt = now();
  const jobId = `vimp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const nextSourceId = defaultSourceIdFactory();

  // 1. Build the ImportJobStore. Prefer the SQLite-backed store (Rust
  //    IPC slice 1); fall back to the in-memory store when the Rust
  //    side isn't shipped yet. The fallback keeps the renderer working
  //    in dev builds where the user hasn't rebuilt the Tauri binary
  //    against the slice-1 commands.
  const initialJob: ImportJob = {
    id: jobId,
    status: "queued",
    sourceProvider: opts.provider,
    sourceMode: opts.mode,
    fileCount: opts.sources.length,
    processedCount: 0,
    failedCount: 0,
    warningCount: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
    schemaVersion: 1,
  };
  const sqliteStore = await createSqliteJobStore();
  const store = sqliteStore ?? createMemoryJobStore(initialJob);
  // SQLite store starts empty; insert the initial row so subsequent
  // updateJobStatus / incrementCounts have a row to UPDATE.
  if (sqliteStore) {
    await sqliteStore.insertJob(initialJob);
  }
  opts.onProgress?.({ kind: "job_created", jobId });

  // When the job is a Drive import, resolve the active connection up
  // front. If the Rust side hasn't shipped the gdrive_* commands yet
  // (slice 12), `connectionId` stays null and every Drive source
  // degrades to extractionStatus="failed" with a clear warning -- the
  // runner then routes the job to needs_review like any other partial
  // failure (slice 9 pattern for unsupported extensions).
  let driveConnectionId: string | null = null;
  let driveCommandsWired = false;
  if (opts.provider === "google_drive") {
    try {
      const conn = await buildDriveClient().getConnection();
      driveCommandsWired = true;
      driveConnectionId = conn?.id ?? null;
    } catch (err) {
      if (!(err instanceof DriveCommandNotWiredError)) throw err;
      // driveCommandsWired stays false; sources will fail per-row.
    }
  }
  const driveClient = opts.provider === "google_drive" ? buildDriveClient() : null;

  const stagedSources: SourceDocument[] = [];
  const driveFetchFailures: Map<string, string> = new Map();
  for (const src of opts.sources) {
    // Drive-sourced inputs are marked with absolutePath = __drive__/<fileId>.
    // Before staging, fetch the bytes via gdrive_download_file or
    // gdrive_export_doc (Workspace docs). The Rust side writes them
    // into _vault/_import-cache and returns the cached absolute path.
    let cachedAbsolutePath = src.absolutePath;
    let resolvedExtension = src.fileExtension;
    let resolvedByteSize = src.byteSize;
    if (src.absolutePath.startsWith("__drive__/") && driveClient) {
      const fileId = src.absolutePath.slice("__drive__/".length);
      if (!driveCommandsWired || !driveConnectionId) {
        driveFetchFailures.set(
          src.absolutePath,
          driveCommandsWired
            ? "no active Google Drive connection"
            : "gdrive_* Tauri commands not registered yet (slice 12 stub)"
        );
      } else {
        try {
          const fetched = await driveClient.fetchSourceBytes({
            connectionId: driveConnectionId,
            file: {
              id: fileId,
              name: src.originalName,
              mimeType: src.mimeType ?? "application/octet-stream",
              isFolder: false,
              isWorkspaceDoc: (src.mimeType ?? "").startsWith("application/vnd.google-apps."),
            },
            workspaceRoot: opts.workspaceRoot,
          });
          if (fetched) {
            cachedAbsolutePath = fetched.absolutePath;
            resolvedByteSize = fetched.byteSize;
            // pick up extension off the returned cached path
            const ext = fetched.cachedRelativePath.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
            if (ext) resolvedExtension = ext;
          } else {
            driveFetchFailures.set(
              src.absolutePath,
              "Workspace file type has no Office export target"
            );
          }
        } catch (err) {
          if (err instanceof DriveCommandNotWiredError) {
            driveCommandsWired = false;
            driveFetchFailures.set(
              src.absolutePath,
              "gdrive_* Tauri commands not registered yet (slice 12 stub)"
            );
          } else {
            driveFetchFailures.set(
              src.absolutePath,
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      }
    }

    // Stage the source into the import cache. Three branches:
    //   1. Drive (already staged above by the Drive client; cachedAbsolutePath
    //      points at the cached copy and resolvedByteSize is set).
    //   2. Paste (synthetic __paste__/<id>.txt path). Look up the text in
    //      globalThis.__VAULT_PASTES__ and call vault_save_pasted_blob to
    //      write it to the cache.
    //   3. Local file. Hash via vault_hash_file then copy via vault_stage_file.
    // Each Rust call goes through safeInvoke so when the IPC isn't wired
    // (slice 2 not built into the binary) we degrade to the slice-9 synthetic
    // hash + cached path string, and the runner downstream marks the source
    // as needs_review via the same "vault_read_file_bytes Tauri command not
    // wired" path the extractor ports already have.
    let contentHash: string | null = null;
    let cachedRelativePath: string | null = null;
    let stagedAbsolutePath: string | null = null;
    let stagedByteSize: number | undefined = resolvedByteSize;
    const isPaste = src.absolutePath.startsWith("__paste__/");
    const isDrive = src.absolutePath.startsWith("__drive__/");

    if (isPaste) {
      const pasteText = globalThis.__VAULT_PASTES__?.get(src.absolutePath) ?? "";
      // Rust signature: `vault_save_pasted_blob(args: SavePastedBlobArgs)`.
      // Tauri 2 deserialises the invoke payload as a struct where each
      // top-level key maps to a parameter name -- a single-struct
      // command needs the fields nested under the parameter name
      // ("args" here), not passed flat. Flat fields would surface as
      // "missing field `args`" once the binary was rebuilt with the
      // slice-2 commands registered.
      const blob = await safeInvoke<{
        cachedRelativePath: string;
        absolutePath: string;
        contentHash: string;
        byteSize: number;
      } | null>("vault_save_pasted_blob", {
        args: {
          workspaceRoot: opts.workspaceRoot,
          text: pasteText,
          title: src.originalName,
        },
      });
      if (blob) {
        contentHash = blob.contentHash;
        cachedRelativePath = blob.cachedRelativePath;
        stagedAbsolutePath = blob.absolutePath;
        stagedByteSize = blob.byteSize;
        resolvedExtension = "txt";
      }
    } else if (!isDrive) {
      // Local file: hash → stage.
      const hashRes = await safeInvoke<string | null>("vault_hash_file", {
        absolutePath: src.absolutePath,
      });
      if (hashRes) {
        // Rust signature: `vault_stage_file(args: StageFileArgs)`. See
        // the vault_save_pasted_blob comment above -- single-struct
        // params need the wrap. `vault_hash_file` and
        // `vault_read_file_bytes` above DON'T need this because they
        // each take a plain `absolute_path: String` rather than a struct.
        const stageRes = await safeInvoke<{
          cachedRelativePath: string;
          absolutePath: string;
          contentHash: string;
          byteSize: number;
        } | null>("vault_stage_file", {
          args: {
            absolutePath: src.absolutePath,
            workspaceRoot: opts.workspaceRoot,
            hash: hashRes,
            extension: resolvedExtension ?? null,
          },
        });
        if (stageRes) {
          contentHash = stageRes.contentHash;
          cachedRelativePath = stageRes.cachedRelativePath;
          stagedAbsolutePath = stageRes.absolutePath;
          stagedByteSize = stageRes.byteSize;
        }
      }
    } else {
      // Drive: cachedAbsolutePath + driveClient already populated above.
      // We still need to derive a contentHash + cachedRelativePath off
      // the staged file; the Drive client returned `contentHash` from
      // gdrive_download_file. Reconstruct the relative path from the
      // absolute one we got.
      // (Drive's StagedFile envelope mirrors vault_stage_file's, but we
      //  don't have access to it here in the loop's scope — instead we
      //  rely on the existing Drive flow to have written into the cache
      //  under the same naming scheme. The runner reads via the relative
      //  path string so the synthetic fallback below still works.)
    }

    // Slice 9 fallback: when the Rust filesystem commands aren't wired
    // (slice 2 not yet built), we don't have a real hash or cached
    // path. Synthesize a stable one so the runner can still produce a
    // SourceDocument row; the extractor port will degrade to needs_review.
    if (contentHash === null) {
      contentHash = `stub-${jobId}-${stagedSources.length.toString(16).padStart(4, "0")}`;
    }
    if (cachedRelativePath === null) {
      cachedRelativePath = `_vault/_import-cache/${contentHash.slice(0, 2)}/${contentHash.slice(2)}${
        resolvedExtension ? `.${resolvedExtension}` : ""
      }`;
    }
    if (stagedAbsolutePath !== null) {
      cachedAbsolutePath = stagedAbsolutePath;
    }
    const driveFetchError = driveFetchFailures.get(src.absolutePath);
    const doc: SourceDocument = {
      id: nextSourceId(),
      importJobId: jobId,
      sourceType: src.sourceType,
      sourceProvider: opts.provider,
      originalName: src.originalName,
      ...(src.mimeType ? { mimeType: src.mimeType } : {}),
      ...(resolvedExtension ? { fileExtension: resolvedExtension } : {}),
      cachedOriginalPath: cachedRelativePath,
      contentHash,
      ...(stagedByteSize !== undefined ? { byteSize: stagedByteSize } : {}),
      extractionStatus: driveFetchError ? "failed" : "pending",
      confidence: "medium",
      needsReview: driveFetchError !== undefined,
      createdAt: startedAt,
      schemaVersion: 1,
    };
    stagedSources.push(doc);
    await store.insertSource(doc);
    opts.onProgress?.({ kind: "source_staged", sourceId: doc.id, originalName: doc.originalName });
    if (driveFetchError) {
      opts.onProgress?.({
        kind: "source_failed",
        sourceId: doc.id,
        originalName: doc.originalName,
        error: `Drive fetch failed: ${driveFetchError}`,
      });
    }
  }

  // 2. Flip job to needs_review (mirrors what processImportJob would do
  //    if staging happened Rust-side).
  await store.updateJobStatus(jobId, "needs_review");
  const job = (await store.getJob(jobId)) as ImportJob;

  // 3. Resolve the LLM caller. Optional -- offline mode still produces a
  //    full pipeline run via deterministic fallbacks.
  let llmCaller: Awaited<ReturnType<typeof buildPipelineLlmCaller>> = null;
  if (opts.ventureId) {
    llmCaller = await buildPipelineLlmCaller({
      ventureId: opts.ventureId,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      enableWebSearch: false,
    });
  }

  const runner = new VaultStageRunner({
    job,
    sources: stagedSources,
    workspaceRoot: opts.workspaceRoot,
    resolveCachedPath: (rel) =>
      `${opts.workspaceRoot.replace(/[\\/]+$/, "")}/${rel.replace(/^\/+/, "")}`,
    candidates: opts.candidates,
    extractDocument: documentPort,
    extractImage: imagePort,
    extractChat: chatPort,
    ...(llmCaller ? { callLlm: llmCaller.callLlm } : {}),
    vaultFs: createMemoryFsPort(),
    store,
    logger: createImportLogger(jobId),
    nowFn: opts.nowFn ?? (() => new Date().toISOString()),
  });

  const run = await runner.run();

  // 4. Forward the runner's log messages as phase progress events.
  for (const entry of run.logs) {
    opts.onProgress?.({ kind: "phase", message: entry.message, ...(entry.data ? { data: entry.data } : {}) });
  }
  for (const p of run.perSource) {
    if (p.extraction.kind === "failed") {
      opts.onProgress?.({
        kind: "source_failed",
        sourceId: p.source.id,
        originalName: p.source.originalName,
        error: p.extraction.error,
      });
    }
  }
  if (run.status === "needs_review") {
    opts.onProgress?.({ kind: "ready_for_review", jobId });
    // Resumable-imports arc: persist drafts / matches / items so a
    // reload between phase 9 and commit doesn't lose the runner
    // state. Only fires when the SQLite store probe succeeded
    // (otherwise we have no Rust IPC to write to). Failures here
    // are non-fatal -- the in-session pending review still works;
    // we just won't survive a reload.
    if (sqliteStore !== null) {
      await persistRunForResume(run, opts.nowFn ?? (() => new Date().toISOString()));
    }
  }

  return {
    job,
    run,
    runner,
    llmConfigured: llmCaller !== null,
    // Wrap the runner's finalize so cleanup fires after a successful
    // commit. The runner itself doesn't know about the persisted
    // support rows (drafts/matches/items live in the desktop helper's
    // resumable-imports path, not the runner). Failures in cleanup
    // are surfaced via the result's `warnings` array; they don't roll
    // back the commit -- the markdown is already on disk.
    finalize: async (input) => {
      const result = await runner.finalize(input);
      if (result.status === "committed" && sqliteStore !== null) {
        try {
          await invoke<void>("vault_cleanup_committed_job_support", { jobId });
        } catch (err) {
          result.warnings.push(
            `vault_cleanup_committed_job_support failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      return result;
    },
  };
}

/**
 * Write every match / item / draft from a `needs_review` run to
 * SQLite via the Tauri commands added in slice B1. Idempotent thanks
 * to `INSERT OR REPLACE` on every row -- a re-run of the same job
 * overwrites the prior persisted state cleanly.
 *
 * Failures are caught + logged; we never throw because the in-memory
 * pending review is the source of truth during the live session.
 * Persistence is a recoverability feature, not a correctness one.
 */
async function persistRunForResume(
  run: VaultRunResult,
  now: () => string
): Promise<void> {
  try {
    // Flatten matches per source into one big array; each
    // ProjectMatch has its own primary key so inserts are independent.
    for (const list of Object.values(run.matches)) {
      for (const m of list) {
        await invoke<void>("vault_insert_project_match", {
          row: {
            id: m.id,
            sourceDocumentId: m.sourceDocumentId,
            projectId: m.projectId,
            ...(m.suggestedProjectName ? { suggestedProjectName: m.suggestedProjectName } : {}),
            confidence: m.confidence,
            ...(m.reason ? { reason: m.reason } : {}),
            status: m.status,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
          },
        });
      }
    }
    for (const list of Object.values(run.items)) {
      for (const it of list) {
        await invoke<void>("vault_insert_extracted_item", {
          row: {
            id: it.id,
            sourceDocumentId: it.sourceDocumentId,
            projectId: it.projectId,
            type: it.type,
            title: it.title,
            content: it.content,
            confidence: it.confidence,
            status: it.status,
            createdAt: it.createdAt,
            updatedAt: it.updatedAt,
          },
        });
      }
    }
    for (const d of run.drafts) {
      await invoke<void>("vault_insert_note_draft", {
        row: {
          id: d.noteId,
          importJobId: run.jobId,
          sourceDocumentId: d.sourceDocumentId,
          noteType: d.noteType,
          suggestedVentureSlug: d.suggestedVentureSlug ?? null,
          title: d.title,
          previewContent: d.previewContent,
          previewFrontmatterJson: JSON.stringify(d.previewFrontmatter),
          itemIdsJson: JSON.stringify(d.itemIds ?? []),
          tagsJson: JSON.stringify(d.tags ?? []),
          confidence: d.confidence ?? null,
          variablesJson: JSON.stringify(d.variables ?? {}),
          createdAt: now(),
          // Stamp the runtime template version so boot hydration can
          // detect drafts produced before a template-content change
          // and re-render them at finalize time.
          templateVersion: VAULT_TEMPLATE_VERSION,
        },
      });
    }
  } catch (err) {
    console.warn(
      "[run-vault-import] persist-for-resume failed; in-session pending review unaffected",
      err
    );
  }
}

// Re-exports the wizard + progress screens reach for so they can stay
// at one import line each.
export type {
  ChatConversation,
  ProjectCandidate,
  SourceDocument,
  VaultFinalizeInput,
  VaultFinalizeResult,
  VaultRunResult,
  VaultStageRunner,
};
