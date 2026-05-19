/**
 * Slice 7 -- frontmatter encode + decode for vault notes.
 *
 * CLIENT-SAFE. The format is a tiny YAML subset:
 *
 *   - opens with `---` on its own line
 *   - one key per line, `key: value` or `key:` + indented `- item` list
 *   - closes with `---` on its own line
 *   - string values containing `:` / `"` / newlines get JSON-encoded
 *   - arrays are flow-style `[a, b, c]` so we don't need block-list parsing
 *
 * Conformance: the schema is `VaultNoteFrontmatterSchema` in vault-contract;
 * both encode and decode round-trip a `VaultNoteFrontmatter`.
 */
import {
  type VaultNoteFrontmatter,
  VaultNoteFrontmatterSchema,
} from "@founder-os/vault-contract";
import { MarkdownVaultError } from "./types.js";

const FRONTMATTER_FENCE = "---";

function needsQuote(s: string): boolean {
  return /[:"\n#\[\]{}&*!|>%@`,]/.test(s) || /^\s|\s$/.test(s) || s.length === 0;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function encodeScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return needsQuote(value) ? quote(value) : value;
}

function encodeArray(arr: ReadonlyArray<string>): string {
  return `[${arr.map((v) => encodeScalar(v)).join(", ")}]`;
}

export function encodeFrontmatter(fm: VaultNoteFrontmatter): string {
  const lines: string[] = [FRONTMATTER_FENCE];
  lines.push(`title: ${encodeScalar(fm.title)}`);
  lines.push(`sourceDocumentId: ${encodeScalar(fm.sourceDocumentId)}`);
  lines.push(
    `projectSlug: ${fm.projectSlug === null ? "null" : encodeScalar(fm.projectSlug)}`
  );
  lines.push(`noteType: ${encodeScalar(fm.noteType)}`);
  lines.push(`tags: ${encodeArray(fm.tags)}`);
  lines.push(`itemIds: ${encodeArray(fm.itemIds)}`);
  if (fm.confidence) {
    lines.push(`confidence: ${encodeScalar(fm.confidence)}`);
  }
  lines.push(`createdAt: ${encodeScalar(fm.createdAt)}`);
  lines.push(FRONTMATTER_FENCE);
  return `${lines.join("\n")}\n`;
}

function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

function parseFlowArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    return [];
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let buf = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      buf += ch;
      continue;
    }
    if (inString) {
      buf += ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out.map((s) => {
    const v = parseScalar(s);
    return typeof v === "string" ? v : String(v);
  });
}

/**
 * Decode the frontmatter block from a vault note markdown file. Returns
 * { frontmatter, body } -- body is the remainder after the closing `---`.
 * Throws MarkdownVaultError when the block is missing or malformed.
 */
export function decodeFrontmatter(source: string): {
  frontmatter: VaultNoteFrontmatter;
  body: string;
} {
  if (!source.startsWith(FRONTMATTER_FENCE)) {
    throw new MarkdownVaultError("vault note is missing leading --- frontmatter fence");
  }
  const afterFirst = source.slice(FRONTMATTER_FENCE.length);
  // Strip the newline immediately after the opening fence (CR/LF or LF).
  const afterFence = afterFirst.replace(/^\r?\n/, "");
  const closing = afterFence.indexOf(`\n${FRONTMATTER_FENCE}`);
  if (closing === -1) {
    throw new MarkdownVaultError("vault note is missing closing --- frontmatter fence");
  }
  const block = afterFence.slice(0, closing);
  // Strip every blank line that sits between the closing fence and the body.
  // Some encoders emit `---\n\nbody`, others `---\nbody` -- be tolerant.
  const body = afterFence
    .slice(closing + 1 + FRONTMATTER_FENCE.length)
    .replace(/^(\r?\n)+/, "");

  const raw: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (value.startsWith("[")) {
      raw[key] = parseFlowArray(value);
    } else {
      raw[key] = parseScalar(value);
    }
  }

  const parsed = VaultNoteFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MarkdownVaultError(
      `frontmatter failed schema: ${first?.path.join(".")} -- ${first?.message}`
    );
  }
  return { frontmatter: parsed.data, body };
}
