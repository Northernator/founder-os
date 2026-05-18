/**
 * Parse helpers for the Deep Research module.
 *
 * Two roles:
 *  1. Thin zod-wrapper helpers (parse / safeParse) mirroring the
 *     handoff-pack-core, backend-core, crm-core convention.
 *  2. `parsePastedDeepResearch` — converts the markdown a founder pastes
 *     back from ChatGPT Deep Research / Gemini Advanced into a
 *     `ProviderPartial`. Heuristic (paste-in is inherently messy) but
 *     deterministic and well-tested.
 *
 * No I/O. Safe in the webview.
 */

import {
  ResearchBriefingSchema,
  ResearchPlanSchema,
  ResearchQuestionSchema,
  SourceSchema,
  type ProviderPartial,
  type ResearchBriefing,
  type ResearchBriefingSection,
  type ResearchChannel,
  type ResearchPlan,
  type ResearchQuestion,
  type Source,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod parse / safeParse wrappers
// ---------------------------------------------------------------------------

export function parseResearchBriefing(input: unknown): ResearchBriefing {
  return ResearchBriefingSchema.parse(input);
}
export function safeParseResearchBriefing(input: unknown) {
  return ResearchBriefingSchema.safeParse(input);
}

export function parseResearchPlan(input: unknown): ResearchPlan {
  return ResearchPlanSchema.parse(input);
}
export function safeParseResearchPlan(input: unknown) {
  return ResearchPlanSchema.safeParse(input);
}

export function parseResearchQuestion(input: unknown): ResearchQuestion {
  return ResearchQuestionSchema.parse(input);
}
export function safeParseResearchQuestion(input: unknown) {
  return ResearchQuestionSchema.safeParse(input);
}

export function parseSource(input: unknown): Source {
  return SourceSchema.parse(input);
}
export function safeParseSource(input: unknown) {
  return SourceSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// Paste-in parser
// ---------------------------------------------------------------------------

const URL_RE = /(https?:\/\/[^\s)<>"']+)/g;
const SECTION_HEADING_RE = /^#{1,3}\s+(.+?)\s*$/;
const SOURCES_BLOCK_RE = /^\s*(\*\*Sources consulted:?\*\*|##\s+Sources(?:\s+consulted)?|##\s+References)\s*:?\s*$/i;

export interface ParsePastedOpts {
  channel: ResearchChannel;
  /** ISO timestamp stamped into each emitted Source.accessedAt. */
  accessedAt: string;
  /** Set of question texts the orchestrator asked — used to fill `unanswered`. */
  expectedQuestions?: ReadonlyArray<string>;
}

/**
 * Parse pasted markdown (ChatGPT Deep Research / Gemini Advanced export)
 * into a `ProviderPartial`.
 *
 * Strategy:
 *   - Split on H2 / H3 headings to discover sections.
 *   - Inside each section, separate prose from the trailing sources block.
 *     A sources block is recognised by a `**Sources consulted:**` line, a
 *     `## Sources` / `## References` H2, OR the heuristic "tail block of
 *     bulleted/numbered lines, each containing a URL".
 *   - URLs get collected; titles default to a host-derived fallback.
 *   - Anything that wasn't inside a recognised section becomes an
 *     intro paragraph attached to the first section (or a synthesised
 *     "Summary" section when the paste has no headings at all).
 *
 * Heuristic by necessity — we accept noisy paste-in. The orchestrator's
 * synthesiser will clean up further; this parser only needs to produce
 * something the schema accepts.
 */
export function parsePastedDeepResearch(
  pastedMarkdown: string,
  opts: ParsePastedOpts,
): ProviderPartial {
  const normalised = pastedMarkdown.replace(/\r\n/g, "\n").trim();
  if (!normalised) {
    return emptyPartial(opts);
  }

  const sectionsRaw = splitOnHeadings(normalised);
  const sectionPartials: ResearchBriefingSection[] = [];
  const allUrls = new Set<string>();

  for (const raw of sectionsRaw) {
    const split = splitProseAndSources(raw.body);
    const urls = extractUrls(split.sourcesBlock + "\n" + split.prose);
    for (const u of urls) allUrls.add(u);
    // Skip empty sections (e.g. a lone heading with no body).
    if (!split.prose.trim() && urls.length === 0) continue;
    sectionPartials.push({
      heading: raw.heading,
      body: split.prose.trim(),
      sources: urls,
    });
  }

  // Edge case: paste with zero headings — synthesise a "Summary" section.
  if (sectionPartials.length === 0) {
    const urls = extractUrls(normalised);
    for (const u of urls) allUrls.add(u);
    sectionPartials.push({
      heading: "Summary",
      body: stripUrls(normalised).trim(),
      sources: urls,
    });
  }

  const sources: Source[] = Array.from(allUrls).map((url) =>
    buildSourceStub(url, opts.channel, opts.accessedAt),
  );

  return {
    sections: sectionPartials,
    sources,
    unanswered: detectUnansweredQuestions(normalised, opts.expectedQuestions),
    rawTranscript: { channel: opts.channel, pastedMarkdown },
  };
}

function emptyPartial(opts: ParsePastedOpts): ProviderPartial {
  return {
    sections: [],
    sources: [],
    unanswered: opts.expectedQuestions ? Array.from(opts.expectedQuestions) : [],
    rawTranscript: { channel: opts.channel, pastedMarkdown: "" },
  };
}

interface RawSection {
  heading: string;
  body: string;
}

function splitOnHeadings(md: string): RawSection[] {
  const lines = md.split("\n");
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  // Capture pre-heading prose under a synthetic "Overview" if present.
  let preheadingBuffer: string[] = [];

  for (const line of lines) {
    const m = SECTION_HEADING_RE.exec(line);
    if (m && m[1]) {
      // New heading: flush the previous section.
      if (current) sections.push(current);
      else if (preheadingBuffer.some((l) => l.trim().length > 0)) {
        sections.push({ heading: "Overview", body: preheadingBuffer.join("\n") });
      }
      current = { heading: m[1], body: "" };
      preheadingBuffer = [];
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else {
      preheadingBuffer.push(line);
    }
  }
  if (current) sections.push(current);
  else if (preheadingBuffer.some((l) => l.trim().length > 0)) {
    sections.push({ heading: "Overview", body: preheadingBuffer.join("\n") });
  }
  return sections;
}

interface ProseAndSources {
  prose: string;
  sourcesBlock: string;
}

function splitProseAndSources(body: string): ProseAndSources {
  const lines = body.split("\n");
  // Pass 1: explicit "**Sources consulted:**" / "## Sources" / "## References".
  let sourcesStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (SOURCES_BLOCK_RE.test(raw)) {
      sourcesStart = i;
      break;
    }
  }
  if (sourcesStart >= 0) {
    return {
      prose: lines.slice(0, sourcesStart).join("\n"),
      sourcesBlock: lines.slice(sourcesStart + 1).join("\n"),
    };
  }
  // Pass 2: heuristic tail block — contiguous trailing bulleted/numbered
  // lines each containing a URL.
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const looksLikeListedSource =
      /^([-*]|\d+\.|\[\d+\])\s/.test(trimmed) && URL_RE.test(trimmed);
    if (looksLikeListedSource) {
      cut = i;
      URL_RE.lastIndex = 0;
      continue;
    }
    break;
  }
  if (cut < lines.length) {
    return {
      prose: lines.slice(0, cut).join("\n"),
      sourcesBlock: lines.slice(cut).join("\n"),
    };
  }
  return { prose: body, sourcesBlock: "" };
}

function extractUrls(text: string): string[] {
  const out = new Set<string>();
  // Reset regex state — URL_RE has the /g flag and is module-level.
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = stripTrailingPunctuation(m[1] ?? "");
    if (url && isParseableUrl(url)) out.add(url);
  }
  URL_RE.lastIndex = 0;
  return Array.from(out);
}

function stripUrls(text: string): string {
  URL_RE.lastIndex = 0;
  const cleaned = text.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n");
  URL_RE.lastIndex = 0;
  return cleaned;
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[).,;:!\]'"]+$/g, "");
}

function isParseableUrl(url: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function buildSourceStub(
  url: string,
  channel: ResearchChannel,
  accessedAt: string,
): Source {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep url as title fallback */
  }
  return {
    url,
    title: host,
    accessedAt,
    retrievedBy: channel,
    // Paste-in defaults to tertiary — we can't verify the source's
    // first-party-ness without re-fetching.
    trustTier: channel === "paste-in" ? "tertiary" : "secondary",
  };
}

/**
 * Flag any expected question text that doesn't appear in the paste — a
 * coarse "did the LLM answer this?" heuristic, used to populate the
 * briefing's `unanswered` list for the re-run flow.
 */
function detectUnansweredQuestions(
  pasted: string,
  expected: ReadonlyArray<string> | undefined,
): string[] {
  if (!expected || expected.length === 0) return [];
  const haystack = pasted.toLowerCase();
  const unanswered: string[] = [];
  for (const q of expected) {
    // A question counts as "addressed" if at least 60% of its keywords
    // (length ≥ 4, lowercased, deduped) appear somewhere in the paste.
    const keywords = Array.from(
      new Set(
        q.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [],
      ),
    );
    if (keywords.length === 0) continue;
    const hits = keywords.filter((k) => haystack.includes(k)).length;
    const ratio = hits / keywords.length;
    if (ratio < 0.6) unanswered.push(q);
  }
  return unanswered;
}
