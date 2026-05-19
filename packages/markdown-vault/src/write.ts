/**
 * Slice 7 -- the `writeVaultNote` orchestrator.
 *
 * Resolves the target path, renders the template, prepends frontmatter,
 * sanitises the body, then hands the bytes to the injected VaultFsPort.
 * Tests pass an in-memory port; the renderer / runner injects a
 * Tauri-command-backed port at runtime.
 */
import type { VaultNoteFrontmatter } from "@founder-os/vault-contract";
import { renderVaultTemplate } from "./engine.js";
import { encodeFrontmatter } from "./frontmatter.js";
import {
  resolveVaultNoteDir,
  resolveVaultNotePath,
  toWorkspaceRelative,
} from "./paths.js";
import { sanitiseVaultMarkdown } from "./sanitiser.js";
import { getVaultTemplate } from "./templates.js";
import {
  MarkdownVaultError,
  type VaultFsPort,
  type WriteVaultNoteInput,
  type WriteVaultNoteResult,
} from "./types.js";

function buildFrontmatter(input: WriteVaultNoteInput): VaultNoteFrontmatter {
  return {
    title: input.title,
    sourceDocumentId: input.sourceDocumentId,
    projectSlug: input.ventureSlug,
    noteType: input.noteType,
    tags: input.tags ?? [],
    itemIds: input.itemIds ?? [],
    ...(input.confidence ? { confidence: input.confidence } : {}),
    createdAt: input.now,
  };
}

/**
 * Render + sanitise the vault note body without touching the disk.
 * Surfaced as a separate export so the desktop UI can preview the note
 * before the user commits the job.
 */
export function renderVaultNoteContent(input: WriteVaultNoteInput): {
  content: string;
  frontmatter: VaultNoteFrontmatter;
  unresolvedPlaceholders: string[];
  warnings: string[];
} {
  const template = getVaultTemplate(input.noteType);
  const { output: rawBody, unresolvedPlaceholders } = renderVaultTemplate(
    template,
    input.variables
  );
  const { output: sanitised, warnings } = sanitiseVaultMarkdown(rawBody);
  const frontmatter = buildFrontmatter(input);
  const fmBlock = encodeFrontmatter(frontmatter);
  return {
    content: `${fmBlock}\n${sanitised.replace(/^\n+/, "")}`,
    frontmatter,
    unresolvedPlaceholders,
    warnings,
  };
}

export async function writeVaultNote(
  input: WriteVaultNoteInput,
  fs: VaultFsPort
): Promise<WriteVaultNoteResult> {
  if (input.noteId.length === 0) {
    throw new MarkdownVaultError("writeVaultNote: noteId must not be empty");
  }
  const dir = resolveVaultNoteDir({
    workspaceRoot: input.workspaceRoot,
    ventureSlug: input.ventureSlug,
    noteType: input.noteType,
  });
  const absolutePath = resolveVaultNotePath({
    workspaceRoot: input.workspaceRoot,
    ventureSlug: input.ventureSlug,
    noteType: input.noteType,
    noteId: input.noteId,
  });

  const rendered = renderVaultNoteContent(input);

  await fs.ensureDir(dir);
  await fs.writeFile(absolutePath, rendered.content);

  return {
    absolutePath,
    relativePath: toWorkspaceRelative(input.workspaceRoot, absolutePath),
    content: rendered.content,
    frontmatter: rendered.frontmatter,
    unresolvedPlaceholders: rendered.unresolvedPlaceholders,
    warnings: rendered.warnings,
  };
}

/**
 * Convenience factory for tests: an in-memory VaultFsPort that records
 * every write into a `files` map.
 */
export function createMemoryFsPort(): VaultFsPort & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async ensureDir(absolutePath) {
      dirs.add(absolutePath);
    },
    async writeFile(absolutePath, content) {
      files.set(absolutePath, content);
    },
    async fileExists(absolutePath) {
      return files.has(absolutePath);
    },
  };
}
