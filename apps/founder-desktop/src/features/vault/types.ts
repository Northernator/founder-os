/**
 * Shared in-renderer types for the Dream Vault feature surface.
 *
 * Slice 10 keeps the post-progress lifecycle in memory at the App
 * level: when a run reaches `needs_review`, the runner instance + its
 * VaultRunResult are stashed in `pendingVaultImports`. The review
 * screen consumes that entry; once the founder commits, it moves to
 * `recentVaultImports`. Both Maps are renderer-only; persistence
 * across reloads lands in slice 12 alongside the Rust IPC for
 * migration 0002-vault.sql.
 */
import type { SourceDocument } from "@founder-os/vault-contract";
import type { RunVaultImportResult, VaultImportSourceInput } from "./run-vault-import.js";

/** One row per import job currently awaiting reviewer approval. */
export type PendingVaultImport = {
  jobId: string;
  /** The runner + run result + finalize callback wrapped by run-vault-import. */
  result: RunVaultImportResult;
  /** The original staged-source list -- handy for filename display. */
  sources: VaultImportSourceInput[];
  /** True iff the run was wired with a real callLlm; surfaces in the panel as a badge. */
  llmConfigured: boolean;
  /** ISO timestamp of when the run reached needs_review. */
  readyAt: string;
};

/**
 * One row per import job recovered from SQLite on boot (Rust IPC arc
 * slice 4). The original session's runner state -- drafts, matches,
 * extracted items -- lives only in renderer memory and doesn't
 * survive a reload, so a recovered entry can only be discarded, not
 * reviewed. The pending-imports panel surfaces these alongside live
 * `PendingVaultImport` rows with a different action set.
 *
 * Persisting drafts/matches/items so reviews can truly resume across
 * reloads is a separate arc -- the schema in migration 0012 has
 * tables for ProjectMatch/ExtractedItem/VaultNote but the runner
 * doesn't write to them today (drafts are transient until the
 * markdown_path lands at commit time).
 */
export type RecoveredVaultImport = {
  jobId: string;
  /** Status from vault_import_jobs.status -- always "needs_review" today. */
  status: string;
  sourceProvider: string;
  sourceMode: string;
  fileCount: number;
  processedCount: number;
  failedCount: number;
  warningCount: number;
  /** Persisted SourceDocument rows for this job. */
  sources: SourceDocument[];
  /** ISO timestamp when the job row was created. */
  createdAt: string;
  /** ISO timestamp when the job row was last updated. */
  updatedAt: string;
};

/** One row per import job the reviewer has already committed. */
export type RecentVaultImport = {
  jobId: string;
  /** Snapshot of the pending entry at commit-time. */
  pending: PendingVaultImport;
  /** What finalize() returned: which notes were written + where. */
  notesWritten: Array<{
    noteId: string;
    sourceDocumentId: string;
    ventureSlug: string | null;
    absolutePath: string;
    relativePath: string;
  }>;
  skippedCount: number;
  warnings: string[];
  /** ISO timestamp of when finalize() resolved. */
  committedAt: string;
};
