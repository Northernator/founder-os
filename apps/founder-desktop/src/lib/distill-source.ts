/**
 * Source aggregation for the "Distill from chat" flow.
 *
 * gatherDistillSources(ventureId, stage, ventureRootPath) returns the chat
 * transcript and excerpts of any text-shaped docs sitting in the venture
 * working directory. Both are read-only — the helper never mutates the chat
 * thread (no insertChatMessage / clearChatThread calls anywhere here) and
 * never writes to disk.
 *
 * Caps:
 *   - Chat transcript: tail-truncated to 10k chars (most-recent wins).
 *   - Each doc: first 4k chars per file.
 *   - Total docs: 20k chars across all files; once the cap is hit further
 *     files are dropped (sorted by mtime DESC so freshest content survives).
 *   - Per-file size guard: 500KB on disk — anything bigger is skipped before
 *     read to keep the IPC response sane.
 *
 * File-type filter is intentionally narrow: txt/md/csv/json/yaml/yml/xml.
 * PDFs and images are out of scope here — the founder's manual upload flow
 * already extracts PDFs to .extracted.txt next to the original, so those
 * land in this scan via the .txt branch.
 */

import type { ChatMessage } from "@founder-os/chat-ui";
import type { VentureStage } from "@founder-os/domain";
import { invoke } from "@tauri-apps/api/core";
import * as db from "./db.js";

const MAX_CHAT_CHARS = 10_000;
const MAX_DOC_CHARS = 4_000;
const MAX_TOTAL_DOC_CHARS = 20_000;
const MAX_DOC_BYTES = 500_000;

const TEXT_EXTS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "yaml",
  "yml",
  "xml",
]);

/** Mirror of Rust `list_dir_recursive` return shape. */
type RustDirEntry = {
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
};

export type DocExcerpt = {
  /** Venture-root-relative path with forward slashes — stable across platforms
   *  so the LLM can quote it back as a citation. */
  path: string;
  /** First N chars of the file body (post per-file + total cap). */
  excerpt: string;
};

export type DistillSources = {
  chatTranscript: string;
  docExcerpts: DocExcerpt[];
};

function flattenChat(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  const lines: string[] = [];
  for (const m of messages) {
    if (!m.content || m.role === "system") continue;
    const role = m.role === "assistant" ? "Assistant" : "User";
    lines.push(`${role}: ${m.content}`);
  }
  const joined = lines.join("\n\n");
  if (joined.length <= MAX_CHAT_CHARS) return joined;
  // Keep the most recent content — that's where the structured analysis
  // tends to live, after the user asks the model to summarise.
  return `…[earlier turns truncated]…\n\n${joined.slice(-MAX_CHAT_CHARS)}`;
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function relativeFrom(root: string, child: string): string {
  const r = toForwardSlashes(root).replace(/\/+$/, "");
  const c = toForwardSlashes(child);
  if (c.startsWith(`${r}/`)) return c.slice(r.length + 1);
  return c;
}

function extOf(path: string): string {
  const norm = toForwardSlashes(path);
  const i = norm.lastIndexOf("/");
  const name = i === -1 ? norm : norm.slice(i + 1);
  const j = name.lastIndexOf(".");
  if (j <= 0) return "";
  return name.slice(j + 1).toLowerCase();
}

async function gatherDocs(ventureRootPath: string): Promise<DocExcerpt[]> {
  let entries: RustDirEntry[];
  try {
    entries = await invoke<RustDirEntry[]>("list_dir_recursive", {
      path: ventureRootPath,
    });
  } catch {
    // Missing dir / permission error — degrade silently, return chat-only.
    return [];
  }

  // Sort by modified DESC so freshest content lands in the cap window first.
  entries.sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));

  const docs: DocExcerpt[] = [];
  let totalChars = 0;
  for (const entry of entries) {
    if (entry.isDir) continue;
    if (entry.sizeBytes > MAX_DOC_BYTES) continue;
    const ext = extOf(entry.path);
    if (!TEXT_EXTS.has(ext)) continue;
    if (totalChars >= MAX_TOTAL_DOC_CHARS) break;

    let body: string;
    try {
      body = await invoke<string>("read_file", { path: entry.path });
    } catch {
      continue;
    }
    if (body.trim().length === 0) continue;

    let excerpt = body.slice(0, MAX_DOC_CHARS);
    const remaining = MAX_TOTAL_DOC_CHARS - totalChars;
    if (excerpt.length > remaining) excerpt = excerpt.slice(0, remaining);

    docs.push({
      path: relativeFrom(ventureRootPath, entry.path),
      excerpt,
    });
    totalChars += excerpt.length;
  }
  return docs;
}

export async function gatherDistillSources(input: {
  ventureId: string;
  stage: VentureStage;
  ventureRootPath: string;
}): Promise<DistillSources> {
  const [messages, docs] = await Promise.all([
    db.listChatMessages(input.ventureId, input.stage).catch(() => [] as ChatMessage[]),
    gatherDocs(input.ventureRootPath),
  ]);
  return {
    chatTranscript: flattenChat(messages),
    docExcerpts: docs,
  };
}

/** Render the gathered sources as a single Markdown block for the LLM
 *  prompt. Stable layout — labels and headings double as citation hooks
 *  the model echoes back ("(chat)" / "(03_brand/notes.md)"). */
export function formatSourcesBlock(sources: DistillSources): string {
  const parts: string[] = [];
  parts.push("## Chat transcript");
  parts.push(
    sources.chatTranscript.trim().length > 0 ? sources.chatTranscript : "(no chat history)"
  );
  if (sources.docExcerpts.length > 0) {
    parts.push("\n## Attached documents");
    for (const doc of sources.docExcerpts) {
      parts.push(`### ${doc.path}\n${doc.excerpt}`);
    }
  }
  return parts.join("\n\n");
}
