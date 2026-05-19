import { type ExtractionResult, ExtractionResultSchema } from "../types";
import { sanitiseMarkdown, summariseMarkdown } from "./helpers";

export interface HtmlInput {
  text: string;
}

/**
 * HTML -> markdown via a small, deterministic subset converter. We don't
 * pull in a full HTML-to-MD lib: the downstream LLM-based summariser
 * cares about prose, not semantic structure. Headings, paragraphs,
 * lists, links, and code blocks survive; everything else is stripped.
 *
 * Important ordering: inline transforms (links, bold, em, code) run
 * BEFORE block transforms (h1..h6, p, li). Block transforms call
 * stripTags on their inner content, so if we ran them first the inline
 * markup would be lost.
 */
export function extractHtml(input: HtmlInput): ExtractionResult {
  const warnings: string[] = [];
  const body = pickBodyContent(input.text);
  let md = body;

  // Drop scripts + styles wholesale (raw content, not just tags).
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Inline transforms FIRST so block-level stripTags doesn't eat them.
  md = md.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
    return `[${stripTags(label).trim()}](${href})`;
  });
  md = md.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  md = md.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  md = md.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, inner: string) => `\n\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n\n`);

  // Block transforms second.
  md = md.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level));
    return `\n\n${hashes} ${stripTags(inner).trim()}\n\n`;
  });
  md = md.replace(/<p>([\s\S]*?)<\/p>/gi, (_, inner: string) => `\n\n${stripTags(inner).trim()}\n\n`);
  md = md.replace(/<li>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${stripTags(inner).trim()}`);
  md = md.replace(/<br\s*\/?>/gi, "\n");

  md = stripTags(md);
  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  const cleaned = sanitiseMarkdown(md, warnings);
  if (!cleaned.trim()) warnings.push("HTML produced empty markdown after extraction");

  return ExtractionResultSchema.parse({
    markdown: cleaned,
    summary: summariseMarkdown(cleaned),
    warnings,
    confidence: cleaned.trim() ? "high" : "low",
    extractionMethod: "html_native",
    needsReview: !cleaned.trim(),
  });
}

function pickBodyContent(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match?.[1] ?? html;
}

function stripTags(input: string): string {
  return input.replace(/<\/?[a-z][^>]*>/gi, "");
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
