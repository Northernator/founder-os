/**
 * Vault docs - longer-form knowledge-base pages for a venture (wiki-style).
 * Stored at <workspaceRoot>/.founder-cowork/vault/<id>.md.
 *
 * Vs. memory: vault docs are full pages (think Obsidian-lite), memory is
 * short fact entries. Same storage shape, different intent.
 */

import * as path from "node:path";
import {
  listEntries,
  readEntry,
  writeEntry,
  deleteEntry,
  idFromTitle,
} from "./markdown-store.js";

export interface VaultDoc {
  id: string;
  title: string;
  tags: string[];
  modifiedAt: number;
  bytes: number;
}

export interface VaultDocBody extends VaultDoc {
  body: string;
}

export interface VaultSaveInput {
  id?: string;
  title: string;
  tags: string[];
  body: string;
}

export function vaultDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".founder-cowork", "vault");
}

export function listVault(workspaceRoot: string): VaultDoc[] {
  return listEntries(vaultDir(workspaceRoot)).map((e) => ({
    id: e.id,
    title: e.frontmatter.title ?? e.id,
    tags: parseTags(e.frontmatter.tags),
    modifiedAt: e.modifiedAt,
    bytes: e.bytes,
  }));
}

export function readVault(workspaceRoot: string, id: string): VaultDocBody {
  const raw = readEntry(vaultDir(workspaceRoot), id);
  return {
    id: raw.id,
    title: raw.frontmatter.title ?? raw.id,
    tags: parseTags(raw.frontmatter.tags),
    body: raw.body,
    modifiedAt: raw.modifiedAt,
    bytes: raw.bytes,
  };
}

export function saveVault(
  workspaceRoot: string,
  input: VaultSaveInput,
): VaultDoc {
  const id = input.id?.trim() || idFromTitle(input.title);
  const written = writeEntry(
    vaultDir(workspaceRoot),
    id,
    {
      title: input.title,
      tags: input.tags.join(", "),
    },
    input.body,
  );
  return {
    id: written.id,
    title: input.title,
    tags: input.tags,
    modifiedAt: written.modifiedAt,
    bytes: written.bytes,
  };
}

export function deleteVault(workspaceRoot: string, id: string): void {
  deleteEntry(vaultDir(workspaceRoot), id);
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
