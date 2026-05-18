/**
 * Slice 6 -- shared deterministic helpers for the Golden 16 steps.
 *
 * NODE-ONLY. Reads files off disk. None of the helpers throw on
 * missing files -- the founder may be running HANDOFF_PACK before
 * every upstream stage has shipped, and the Golden steps must
 * degrade to TODO callouts rather than blowing up the walk.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

/** Read+parse JSON if the file exists. Returns null on missing or bad JSON. */
export async function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read a UTF-8 text file if it exists. Returns null on missing or read error. */
export async function readTextIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** List a directory's entries if it exists. Returns [] on missing or read error. */
export async function readDirIfExists(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * Read every `*.md` file in a directory, top-level only (no recursion
 * -- the Golden steps want surface-level summaries, not the long tail
 * of nested research output). Returns {filename, content} pairs sorted
 * alphabetically for deterministic LLM prompts.
 */
export async function readMarkdownFiles(
  dir: string,
  opts: { limit?: number } = {}
): Promise<{ filename: string; content: string }[]> {
  const names = await readDirIfExists(dir);
  const mdNames = names.filter((n) => n.toLowerCase().endsWith(".md")).sort();
  const limited = opts.limit != null ? mdNames.slice(0, opts.limit) : mdNames;
  const out: { filename: string; content: string }[] = [];
  for (const name of limited) {
    const content = await readTextIfExists(`${dir}/${name}`);
    if (content != null) out.push({ filename: name, content });
  }
  return out;
}

/** Soft-truncate a string for LLM context budgets. Adds an explicit suffix. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n...[truncated]`;
}

/** YYYY-MM-DD slice of an ISO timestamp -- the CURRENT_DATE placeholder. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Render a TODO callout for placeholders the step couldn't fill. The
 * branded CSS surfaces these in amber so the founder spots them at a
 * glance. Keep the wording consistent so global search-and-replace
 * works.
 */
export function todoCallout(field: string, reason: string): string {
  return `> **TODO**: ${field} -- ${reason}`;
}

/**
 * Extract the first heading section's body from a markdown document.
 * Used by Golden steps that want the lead paragraph of a research
 * report without the long tail. Returns null when no body is found.
 */
export function extractFirstSection(md: string, headingPattern: RegExp): string | null {
  const match = md.match(headingPattern);
  if (!match) return null;
  const start = (match.index ?? 0) + match[0].length;
  const rest = md.slice(start);
  const stop = rest.search(/\n#{1,3}\s/);
  const body = stop === -1 ? rest : rest.slice(0, stop);
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Bullet-list rendering helper. Filters out empty entries, prefixes
 * each with "- ", and falls back to a TODO callout when the list is
 * empty.
 */
export function bulletList(items: ReadonlyArray<string>, fallback: string): string {
  const cleaned = items.map((i) => i.trim()).filter((i) => i.length > 0);
  if (cleaned.length === 0) return fallback;
  return cleaned.map((i) => `- ${i}`).join("\n");
}

/**
 * Run a callLlm with timeout + empty-output guard. Returns the trimmed
 * narrative on success; throws on transport failure / empty output so
 * the caller can fall back to deterministic content.
 */
export async function callLlmStrict(
  callLlm: (args: { system: string; user: string }) => Promise<string>,
  args: { system: string; user: string }
): Promise<string> {
  const raw = await callLlm(args);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("LLM returned empty narrative");
  }
  return trimmed;
}
