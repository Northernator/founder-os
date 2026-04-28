/**
 * Memory entries - short notes/facts/snippets the user wants to keep about
 * a venture. Stored at <workspaceRoot>/.founder-cowork/memory/<id>.md.
 *
 * Type vocabulary mirrors the auto-memory system (user/feedback/project/
 * reference) so entries can later be ingested into a unified memory layer
 * (Phase 4 InsForge).
 */

import * as path from "node:path";
import {
  listEntries,
  readEntry,
  writeEntry,
  deleteEntry,
  idFromTitle,
} from "./markdown-store.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryEntry {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  modifiedAt: number;
  bytes: number;
}

export interface MemoryEntryBody extends MemoryEntry {
  body: string;
}

export interface MemorySaveInput {
  /** Empty / undefined = create new (id derived from name). */
  id?: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export function memoryDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".founder-cowork", "memory");
}

export function listMemory(workspaceRoot: string): MemoryEntry[] {
  return listEntries(memoryDir(workspaceRoot)).map((e) => ({
    id: e.id,
    name: e.frontmatter.name ?? e.id,
    description: e.frontmatter.description ?? "",
    type: coerceType(e.frontmatter.type),
    modifiedAt: e.modifiedAt,
    bytes: e.bytes,
  }));
}

export function readMemory(workspaceRoot: string, id: string): MemoryEntryBody {
  const raw = readEntry(memoryDir(workspaceRoot), id);
  return {
    id: raw.id,
    name: raw.frontmatter.name ?? raw.id,
    description: raw.frontmatter.description ?? "",
    type: coerceType(raw.frontmatter.type),
    body: raw.body,
    modifiedAt: raw.modifiedAt,
    bytes: raw.bytes,
  };
}

export function saveMemory(
  workspaceRoot: string,
  input: MemorySaveInput,
): MemoryEntry {
  const id = input.id?.trim() || idFromTitle(input.name);
  const written = writeEntry(
    memoryDir(workspaceRoot),
    id,
    {
      name: input.name,
      description: input.description,
      type: input.type,
    },
    input.body,
  );
  return {
    id: written.id,
    name: input.name,
    description: input.description,
    type: input.type,
    modifiedAt: written.modifiedAt,
    bytes: written.bytes,
  };
}

export function deleteMemory(workspaceRoot: string, id: string): void {
  deleteEntry(memoryDir(workspaceRoot), id);
}

function coerceType(value: string | undefined): MemoryType {
  if (value && (MEMORY_TYPES as string[]).includes(value)) {
    return value as MemoryType;
  }
  return "user";
}
