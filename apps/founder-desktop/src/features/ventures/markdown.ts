/**
 * Tiny standalone markdown → HTML renderer for the artifact preview pane.
 *
 * Why not a library: we want zero new deps and the artifact preview only
 * needs to make pipeline-produced markdown legible — full CommonMark would
 * be overkill. If the renderer ever needs tables / footnotes / autolinks,
 * swap to `marked` and delete this file.
 *
 * Supported:
 *   - ATX headings (#, ##, ### up to ######)
 *   - Fenced code blocks (``` ... ```)
 *   - Bullet lists (-, *)
 *   - Numbered lists (1. 2. 3.)
 *   - Paragraphs (blank-line separated)
 *   - Inline: `code`, **bold**, *italic*, [text](url), <br>
 *
 * The output is then injected via dangerouslySetInnerHTML, so every input
 * is escaped before any markdown parsing runs. The final string can only
 * contain tags this file emits — never raw user content.
 */

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]!);
}

// Inline transforms applied to already-escaped text. Order matters:
// code spans get pulled out first so later passes don't touch their innards.
function renderInline(s: string): string {
  let out = s;

  // Inline code — pull out so subsequent regexes don't touch it.
  // We process by replace; because the input is already escaped, backticks
  // can't break out of a code span.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, inner) => {
    codeSpans.push(inner);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // Bold — ** ... ** (greedy is fine since markdown isn't strict)
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic — single *. Avoid eating ** by using lookahead/behind.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  // Links — [text](url). URL is already escaped, but we still validate the
  // scheme to block javascript: links.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    if (!/^(https?:|mailto:|#)/i.test(url)) {
      return `${text} (${url})`;
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Restore code spans.
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
    const i = parseInt(idx, 10);
    return `<code style="background:#F3F4F6;padding:1px 5px;border-radius:3px;font-size:0.9em;">${codeSpans[i]}</code>`;
  });

  return out;
}

/** Block-level pass — splits into paragraphs / lists / code blocks. */
export function renderMarkdown(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let i = 0;
  // Track list state so consecutive list items collapse into one <ul>/<ol>.
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      closeLists();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or EOF)
      out.push(
        `<pre style="margin:12px 0;padding:12px;background:#0B1020;color:#E5E7EB;border-radius:6px;overflow:auto;font-size:12px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"><code>${escapeHtml(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      const text = renderInline(escapeHtml(heading[2]));
      const sizes = [22, 18, 16, 14, 13, 13];
      const margins = [16, 14, 12, 10, 8, 8];
      out.push(
        `<h${level} style="margin:${margins[level - 1]}px 0 6px;font-size:${sizes[level - 1]}px;font-weight:700;color:#111827;">${text}</h${level}>`
      );
      i++;
      continue;
    }

    // Bullet list item
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push('<ul style="margin:8px 0;padding-left:22px;">'); inUl = true; }
      out.push(`<li style="margin:2px 0;">${renderInline(escapeHtml(ul[1]))}</li>`);
      i++;
      continue;
    }

    // Numbered list item
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push('<ol style="margin:8px 0;padding-left:22px;">'); inOl = true; }
      out.push(`<li style="margin:2px 0;">${renderInline(escapeHtml(ol[1]))}</li>`);
      i++;
      continue;
    }

    // Blank line — paragraph break
    if (line.trim() === "") {
      closeLists();
      i++;
      continue;
    }

    // Otherwise — paragraph. Gather contiguous non-blank, non-block lines.
    closeLists();
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(
      `<p style="margin:8px 0;">${renderInline(escapeHtml(buf.join(" ")))}</p>`
    );
  }

  closeLists();
  return out.join("");
}
