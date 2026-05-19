/**
 * Slice 7 -- markdown sanitiser for rendered vault notes.
 *
 * CLIENT-SAFE -- pure text in / text out. The vault is local-first and
 * never published, so the goal here is defence-in-depth: catch obvious
 * footguns in user-supplied content (chat exports, OCR text, scraped
 * documents) before they hit disk.
 *
 * Rules:
 *   1. Strip <script>...</script> blocks completely.
 *   2. Strip dangerous on-* event handler attributes from any HTML tag.
 *   3. Normalise heading depth: ##### and deeper become ####.
 *   4. Leave fenced code blocks (``` / ~~~ / 4-space indented) UNTOUCHED.
 *
 * The function surfaces a list of `warnings` so the runner can record
 * "stripped 2 script blocks, normalised 5 over-deep headings" in the
 * job log.
 */

export type SanitiseResult = {
  output: string;
  warnings: string[];
};

const FENCE_PATTERN = /^(\s*)(```|~~~)/;
const MAX_HEADING_DEPTH = 4;

/**
 * Split markdown into segments tagged as `text` (sanitise) or `code`
 * (leave alone). Fenced code uses a stack so nested or mismatched
 * fences degrade gracefully.
 */
function segment(markdown: string): { kind: "text" | "code"; content: string }[] {
  const out: { kind: "text" | "code"; content: string }[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  let buf: string[] = [];
  let inFence: { marker: string; indent: string } | null = null;

  const flush = (kind: "text" | "code") => {
    if (buf.length > 0) {
      out.push({ kind, content: buf.join("\n") });
      buf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!inFence) {
      const m = line.match(FENCE_PATTERN);
      if (m) {
        flush("text");
        inFence = { marker: m[2] ?? "```", indent: m[1] ?? "" };
        buf.push(line);
      } else {
        buf.push(line);
      }
    } else {
      buf.push(line);
      const trimmed = line.trim();
      if (trimmed === inFence.marker || trimmed.startsWith(inFence.marker)) {
        // We saw a fence line that matches the open marker; treat as close.
        if (line.trim().startsWith(inFence.marker) && buf.length > 1) {
          flush("code");
          inFence = null;
        }
      }
    }
    i += 1;
  }
  if (inFence) {
    // Unterminated fence -- preserve as code for safety.
    flush("code");
  } else {
    flush("text");
  }
  return out;
}

type Counters = {
  scripts: number;
  handlers: number;
  headings: number;
};

function stripScripts(content: string, counters: Counters): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => {
      counters.scripts += 1;
      return "";
    })
    .replace(/<script\b[^>]*\/>/gi, () => {
      counters.scripts += 1;
      return "";
    });
}

function stripEventHandlers(content: string, counters: Counters): string {
  return content.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
    counters.handlers += 1;
    return "";
  });
}

function normaliseHeadings(content: string, counters: Counters): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(#{1,6})(\s+)(.*)$/);
      if (!m) return line;
      const hashes = m[1] ?? "";
      const space = m[2] ?? " ";
      const rest = m[3] ?? "";
      if (hashes.length <= MAX_HEADING_DEPTH) return line;
      counters.headings += 1;
      return `${"#".repeat(MAX_HEADING_DEPTH)}${space}${rest}`;
    })
    .join("\n");
}

export function sanitiseVaultMarkdown(markdown: string): SanitiseResult {
  const counters: Counters = { scripts: 0, handlers: 0, headings: 0 };
  const segments = segment(markdown);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "code") {
      out.push(seg.content);
      continue;
    }
    let text = seg.content;
    text = stripScripts(text, counters);
    text = stripEventHandlers(text, counters);
    text = normaliseHeadings(text, counters);
    out.push(text);
  }
  const warnings: string[] = [];
  if (counters.scripts > 0) {
    warnings.push(
      `stripped ${counters.scripts} <script> block${counters.scripts === 1 ? "" : "s"}`
    );
  }
  if (counters.handlers > 0) {
    warnings.push(
      `stripped ${counters.handlers} inline event handler${counters.handlers === 1 ? "" : "s"} (on*=...)`
    );
  }
  if (counters.headings > 0) {
    warnings.push(
      `normalised ${counters.headings} heading${counters.headings === 1 ? "" : "s"} deeper than h${MAX_HEADING_DEPTH}`
    );
  }
  return { output: out.join("\n"), warnings };
}
