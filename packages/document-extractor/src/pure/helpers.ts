/**
 * Markdown sanitiser + lightweight summariser shared by every text-based
 * extractor. The vault rendering layer (slice 7) runs its own sanitiser
 * too; this is the first-pass guard so junk doesn't reach the LLM.
 */

const MAX_HEADING_DEPTH = 4;

export function sanitiseMarkdown(text: string, warnings: string[]): string {
  let out = text;

  // Strip script tags + their content -- these survive a naive HTML strip.
  if (/<script\b/i.test(out)) warnings.push("removed <script> blocks");
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Clamp very-deep headings -- LLM prompts choke on `########` and deeper.
  out = out.replace(/^#{5,}/gm, "#".repeat(MAX_HEADING_DEPTH));

  // Normalise line endings + clamp runs of blank lines.
  out = out.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");

  return out;
}

/**
 * Trivial "first paragraph" summariser. The LLM-aware summary is added
 * later by the knowledge-extractor (slice 6); this just gives the UI
 * something to show before that runs.
 */
export function summariseMarkdown(text: string): string | undefined {
  if (!text || !text.trim()) return undefined;
  const para = text
    .replace(/^#+ .*$/gm, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (!para) return undefined;
  return para.length > 280 ? `${para.slice(0, 277)}...` : para;
}
