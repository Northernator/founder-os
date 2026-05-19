/**
 * Slice 7 -- shared types for the markdown-vault package.
 *
 * CLIENT-SAFE -- no node:* imports, no filesystem. Disk writes happen
 * via the injectable `VaultFsPort` so the renderer can wire a Tauri-
 * command-backed port and tests can use an in-memory stub.
 */
import {
  type Confidence,
  type VaultNoteFrontmatter,
  type VaultNoteType,
} from "@founder-os/vault-contract";

/**
 * Disk seam for writing vault notes. The runner (slice 8) wires this
 * to a Tauri command on the renderer side, or to node:fs/promises on
 * the Node side. Tests pass an in-memory implementation.
 */
export interface VaultFsPort {
  /** Ensure the directory exists, recursively. Idempotent. */
  ensureDir(absolutePath: string): Promise<void>;
  /** Write UTF-8 text content to the absolute path, replacing if it exists. */
  writeFile(absolutePath: string, content: string): Promise<void>;
  /** True iff a file exists at the absolute path. */
  fileExists(absolutePath: string): Promise<boolean>;
}

/** Inputs the runner hands to `writeVaultNote`. */
export type WriteVaultNoteInput = {
  /** Workspace root -- parent of `_vault/`. */
  workspaceRoot: string;
  /** Project-scoped venture slug, or `null` for the unsorted area. */
  ventureSlug: string | null;
  /** Which template + which numbered subdir to write into. */
  noteType: VaultNoteType;
  /** ID used for filename + frontmatter cross-ref. */
  noteId: string;
  /** Display title -- also written to frontmatter + first heading. */
  title: string;
  /** Foreign key into vault_source_documents.id (frontmatter). */
  sourceDocumentId: string;
  /** Item ids the note groups (frontmatter). */
  itemIds?: string[];
  /** Tags (frontmatter). */
  tags?: string[];
  /** Confidence (frontmatter). */
  confidence?: Confidence;
  /** ISO timestamp -- threaded to the template + frontmatter. */
  now: string;
  /** Per-template variables. See `./templates.ts` for the expected keys. */
  variables: Readonly<Record<string, unknown>>;
};

/** What `writeVaultNote` returns. */
export type WriteVaultNoteResult = {
  /** Absolute path the note was written to. */
  absolutePath: string;
  /** Workspace-relative path (same value the SQLite row stores). */
  relativePath: string;
  /** The full markdown (frontmatter + sanitised body) that was written. */
  content: string;
  frontmatter: VaultNoteFrontmatter;
  /** Placeholders the template referenced but the variables didn't fill. */
  unresolvedPlaceholders: string[];
  /** Warnings the sanitiser surfaced (e.g. stripped <script> tags). */
  warnings: string[];
};

export class MarkdownVaultError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MarkdownVaultError";
  }
}
