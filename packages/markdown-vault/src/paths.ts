/**
 * Slice 7 -- noteType -> vault path resolution.
 *
 * CLIENT-SAFE -- delegates to @founder-os/workspace-core helpers. Maps
 * each VaultNoteType onto the correct numbered subdir under
 * _vault/projects/<slug>/ (project-scoped) or _vault/unsorted/<kind>/
 * (when the source is unsorted).
 */
import {
  type VaultProjectDirKey,
  getVaultProjectSubdir,
  getVaultUnsortedDir,
} from "@founder-os/workspace-core";
import type { VaultNoteType } from "@founder-os/vault-contract";

/**
 * Per-vault-note-type subdir for project-scoped notes. `image_note`
 * shares `documentSummaries` per spec §1.5 (images live alongside docs
 * in 20_document-summaries/).
 */
const NOTE_TYPE_TO_PROJECT_DIR: Record<VaultNoteType, VaultProjectDirKey> = {
  project_index: "index",
  chat_summary: "chatSummaries",
  document_summary: "documentSummaries",
  image_note: "documentSummaries",
  decision_log: "decisions",
  task_list: "tasks",
  prompt_pack: "prompts",
  research_note: "research",
  brand_reference: "brandReferences",
  ui_reference: "uiReferences",
  raw_archive: "rawArchive",
};

/** Kebab-cased bucket name under _vault/unsorted/<bucket>/ for orphan notes. */
const NOTE_TYPE_TO_UNSORTED_BUCKET: Record<VaultNoteType, string> = {
  project_index: "indexes",
  chat_summary: "chat-summaries",
  document_summary: "document-summaries",
  image_note: "image-notes",
  decision_log: "decisions",
  task_list: "tasks",
  prompt_pack: "prompts",
  research_note: "research",
  brand_reference: "brand-references",
  ui_reference: "ui-references",
  raw_archive: "raw-archive",
};

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

function sanitiseFilenameSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve the directory a vault note of this type should land in.
 * Project-scoped notes (ventureSlug present) go under the venture's
 * numbered subtree; orphan notes (ventureSlug=null) go under
 * _vault/unsorted/<bucket>/.
 */
export function resolveVaultNoteDir(opts: {
  workspaceRoot: string;
  ventureSlug: string | null;
  noteType: VaultNoteType;
}): string {
  if (opts.ventureSlug !== null) {
    const key = NOTE_TYPE_TO_PROJECT_DIR[opts.noteType];
    return getVaultProjectSubdir(opts.workspaceRoot, opts.ventureSlug, key);
  }
  const bucket = NOTE_TYPE_TO_UNSORTED_BUCKET[opts.noteType];
  return joinPath(getVaultUnsortedDir(opts.workspaceRoot), bucket);
}

/** Absolute (workspace-relative-prefix-aware) path the note will be written to. */
export function resolveVaultNotePath(opts: {
  workspaceRoot: string;
  ventureSlug: string | null;
  noteType: VaultNoteType;
  noteId: string;
}): string {
  const dir = resolveVaultNoteDir(opts);
  const filename = `${sanitiseFilenameSegment(opts.noteId) || "note"}.md`;
  return joinPath(dir, filename);
}

/**
 * Workspace-relative path for the same note. The runner stores this on
 * the SQLite row so the desktop UI can resolve the path against
 * whichever workspaceRoot is active.
 */
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  // workspace-core's `join` helper strips leading/trailing slashes on every
  // segment, so paths produced by it never carry the absolute prefix that
  // `workspaceRoot` was passed in with. Strip leading slashes from BOTH sides
  // before comparing so callers can hand us either an absolute or a stripped
  // workspaceRoot and still get the right relative path back.
  const stripLeading = (s: string): string =>
    s.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const root = stripLeading(workspaceRoot);
  const path = stripLeading(absolutePath);
  if (root.length === 0) return path;
  if (path === root) return "";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

export { NOTE_TYPE_TO_PROJECT_DIR, NOTE_TYPE_TO_UNSORTED_BUCKET };
