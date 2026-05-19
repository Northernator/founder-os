/**
 * Promote a committed vault note into a venture's tree -- slice 5 of
 * the Rust IPC arc.
 *
 * The note viewer renders a "Promote to venture" button per spec §3
 * slice 10. Until now it pushed a toast saying "lands in slice 12".
 * The TS-side composition below uses the desktop's existing
 * `read_file` / `mkdir_p` / `write_file` commands (lib.rs) — no new
 * Rust is needed since vault notes are UTF-8 markdown.
 *
 * Target layout: `<ventureRoot>/_imports-from-vault/<noteId>__<slug>.md`.
 * One flat bucket per venture keeps the slice small + reviewable;
 * splaying notes across the existing numbered-folder tree (00_brief,
 * 10_research, 20_brand, ...) is a per-venture mapping decision the
 * founder should drive manually rather than via a hard-coded
 * VaultNoteType → folder table. The `_imports-from-vault/` folder is
 * the seam — once a venture's owner moves a note to the right
 * numbered slot, this code never touches that file again.
 */
import type { VaultNoteDraft } from "@founder-os/vault-runner";
import { invoke } from "@tauri-apps/api/core";

export type PromoteResult = {
  /** Absolute path the note now lives at inside the venture tree. */
  absolutePath: string;
  /** Venture-relative path; useful for toast copy + breadcrumbs. */
  relativePath: string;
};

export type PromoteOpts = {
  /** Source: workspace-absolute path of the committed vault note. */
  sourceAbsolutePath: string;
  /** Target venture root from `venture.rootPath`. */
  ventureRoot: string;
  /** The draft, used for the target filename + a brief frontmatter
   *  pass-through. We don't currently rewrite the frontmatter -- the
   *  copy is byte-for-byte. A future arc could re-render with the
   *  venture slug baked in. */
  draft: VaultNoteDraft;
};

/**
 * Read the committed vault note + write it into the venture tree.
 * Throws on failure (the caller toasts the error string). No-op
 * idempotent-by-overwrite: if the target already exists it gets
 * replaced, which matches what the user would expect from re-clicking
 * the button.
 */
export async function promoteNoteToVenture(opts: PromoteOpts): Promise<PromoteResult> {
  const { sourceAbsolutePath, ventureRoot, draft } = opts;

  // 1. Read the source markdown. The renderer's `read_file` command
  //    returns UTF-8 string; vault notes are always UTF-8 markdown so
  //    this round-trip is byte-exact.
  const content = await invoke<string>("read_file", { path: sourceAbsolutePath });

  // 2. Build the target path. Strip trailing separators on the root,
  //    use forward-slash join (Windows accepts both), and sanitise the
  //    title into a filename-safe slug. The note id is the dedupe key
  //    so we always have a unique name even if two drafts share a title.
  const cleanedRoot = ventureRoot.replace(/[\\/]+$/, "");
  const targetDir = `${cleanedRoot}/_imports-from-vault`;
  const slug = slugify(draft.title);
  const filename = `${draft.noteId}__${slug}.md`;
  const targetPath = `${targetDir}/${filename}`;
  const relativePath = `_imports-from-vault/${filename}`;

  // 3. Ensure the parent exists, then write.
  await invoke<void>("mkdir_p", { path: targetDir });
  await invoke<void>("write_file", { path: targetPath, content });

  return { absolutePath: targetPath, relativePath };
}

/**
 * Filename-safe slug derived from a note title. Keep it conservative
 * — anything not [A-Za-z0-9_-] becomes a hyphen, then collapse runs.
 * Falls back to "note" when the title is entirely punctuation.
 */
function slugify(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "note";
}
