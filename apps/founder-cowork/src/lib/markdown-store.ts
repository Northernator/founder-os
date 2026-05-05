/**
 * markdown-store - a tiny CRUD layer over a directory of .md files with
 * frontmatter. Backs both the Memory and Vault tabs.
 *
 * Layout:
 *   <baseDir>/<id>.md
 *
 * File format (intentionally shallow - no YAML dep):
 *   ---
 *   key: value
 *   key: value
 *   ---
 *   {markdown body}
 *
 * Phase 4 swaps this for an InsForge-backed adapter behind the same shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface MdEntry {
  id: string;
  filePath: string;
  frontmatter: Record<string, string>;
  modifiedAt: number;
  bytes: number;
}

export interface MdEntryWithBody extends MdEntry {
  body: string;
}

export function listEntries(baseDir: string): MdEntry[] {
  if (!fs.existsSync(baseDir)) return [];
  const out: MdEntry[] = [];
  for (const file of fs.readdirSync(baseDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(baseDir, file);
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const id = file.replace(/\.md$/, "");
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const { frontmatter } = parseFrontmatter(text);
      out.push({
        id,
        filePath,
        frontmatter,
        modifiedAt: st.mtimeMs,
        bytes: st.size,
      });
    } catch {
      // bad file - skip
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

export function readEntry(baseDir: string, id: string): MdEntryWithBody {
  const filePath = path.join(baseDir, `${sanitizeId(id)}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Entry not found: ${id}`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  const st = fs.statSync(filePath);
  const { frontmatter, body } = parseFrontmatter(text);
  return {
    id,
    filePath,
    frontmatter,
    body,
    modifiedAt: st.mtimeMs,
    bytes: st.size,
  };
}

export function writeEntry(
  baseDir: string,
  id: string,
  frontmatter: Record<string, string>,
  body: string
): MdEntry {
  fs.mkdirSync(baseDir, { recursive: true });
  const safeId = sanitizeId(id);
  if (!safeId) throw new Error("entry id is empty after sanitisation");
  const filePath = path.join(baseDir, `${safeId}.md`);
  const text = renderFrontmatter(frontmatter) + body.replace(/\r\n/g, "\n");
  fs.writeFileSync(filePath, text, "utf8");
  const st = fs.statSync(filePath);
  return {
    id: safeId,
    filePath,
    frontmatter,
    modifiedAt: st.mtimeMs,
    bytes: st.size,
  };
}

export function deleteEntry(baseDir: string, id: string): void {
  const filePath = path.join(baseDir, `${sanitizeId(id)}.md`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

export function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const clean = text.replace(/^\uFEFF/, "");
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: clean };
  const [, fmText, body] = match;
  const fm: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { frontmatter: fm, body };
}

export function renderFrontmatter(frontmatter: Record<string, string>): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return "";
  const lines = ["---"];
  for (const k of keys) {
    const v = frontmatter[k] ?? "";
    // Quote if the value contains characters that confuse our parser.
    const needsQuote = /[:#'"\n]/.test(v);
    lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Slugify a string for use as a filename. Allows letters, digits, hyphen,
 * underscore. Collapses runs of separators. Caps at 80 chars.
 */
export function sanitizeId(raw: string): string {
  return raw
    .toString()
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Generate an id from a free-form title. Falls back to a timestamp if
 * sanitisation strips everything.
 */
export function idFromTitle(title: string): string {
  const slug = sanitizeId(title);
  if (slug) return slug;
  return `entry-${Date.now().toString(36)}`;
}
