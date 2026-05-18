/**
 * Sourced-sections markdown emitter.
 *
 * Renders a `ResearchBriefing` as the human-facing markdown the founder
 * reads (and which the handoff-pack PDF renderer can ingest).
 *
 * Format — spec §8:
 *   # <Topic label>
 *   > Generated <date> via channels: …
 *   ## <Section heading>
 *   <body>
 *   **Sources consulted:**
 *   - <Title>, <publisher>, accessed <YYYY-MM-DD> — <url>
 *   …
 *   ## Provenance & disagreements
 *   - <disagreement lines>
 *
 * No inline citations. The "sources consulted" block at the end of each
 * section is the citation surface. This file is pure — no I/O, no node:*.
 */

import type {
  ResearchBriefing,
  ResearchBriefingSection,
  Source,
} from "./types.js";

/**
 * Render the full sourced-sections markdown for a briefing. Pure string
 * builder — callers write the result to
 * 00_research/deep/briefings/<topic-slug>.md.
 */
export function emitSourcedSectionsMarkdown(
  briefing: ResearchBriefing,
): string {
  const sourceByUrl = new Map(briefing.sources.map((s) => [s.url, s]));

  const parts: string[] = [];

  // ---- Title + provenance frontmatter -----------------------------------
  parts.push(`# ${briefing.topicLabel}`);
  parts.push("");
  parts.push(emitFrontmatterBlockquote(briefing));
  parts.push("");

  // ---- Sections ---------------------------------------------------------
  for (const section of briefing.sections) {
    parts.push(`## ${section.heading}`);
    parts.push("");
    parts.push(section.body.trimEnd());
    parts.push("");
    if (section.sources.length > 0) {
      parts.push(emitSectionSourcesBlock(section, sourceByUrl));
      parts.push("");
    }
  }

  // ---- Provenance & disagreements footer --------------------------------
  parts.push("---");
  parts.push("");
  parts.push("## Provenance & disagreements");
  parts.push("");
  const provenanceLines = emitProvenanceLines(briefing);
  for (const line of provenanceLines) parts.push(line);

  // Trailing newline so editors that "ensure newline at EOF" don't churn.
  return parts.join("\n").trimEnd() + "\n";
}

/**
 * Render the "Sources consulted:" block for a single section.
 * Exported because the parser pairs with this — round-trip property.
 */
export function emitSectionSourcesBlock(
  section: ResearchBriefingSection,
  sourceByUrl: ReadonlyMap<string, Source>,
): string {
  const lines: string[] = ["**Sources consulted:**"];
  for (const url of section.sources) {
    const src = sourceByUrl.get(url);
    lines.push(formatSourceBulletLine(url, src));
  }
  return lines.join("\n");
}

/**
 * Format one bullet inside a "Sources consulted" block. If we have full
 * Source metadata, render "Title, publisher, accessed YYYY-MM-DD — url";
 * otherwise fall back to a bare URL bullet so the block is still parseable.
 */
export function formatSourceBulletLine(
  url: string,
  src: Source | undefined,
): string {
  if (!src) return `- ${url}`;
  const publisher = src.publisher ? `, ${src.publisher}` : "";
  const accessed = src.accessedAt ? `, accessed ${src.accessedAt.slice(0, 10)}` : "";
  return `- ${src.title}${publisher}${accessed} — ${src.url}`;
}

function emitFrontmatterBlockquote(briefing: ResearchBriefing): string {
  const generatedDate = briefing.generatedAt.slice(0, 10);
  const channelList = briefing.channelsUsed.join(", ");
  const crossRef = briefing.crossReferencedBy.length > 0
    ? `Cross-referenced by ${briefing.crossReferencedBy.join(", ")}.`
    : "Cross-reference skipped (single-channel run).";
  const synth = briefing.synthesisedBy
    ? `Synthesised by ${briefing.synthesisedBy}.`
    : "";
  const tally = tallySourceTiers(briefing.sources);
  const sourcesLine = `${briefing.sources.length} sources consulted ` +
    `(${tally.primary} primary, ${tally.secondary} secondary, ${tally.tertiary} tertiary).`;

  return [
    `> Generated ${generatedDate} via channels: ${channelList}.`,
    `> ${crossRef}${synth ? " " + synth : ""}`,
    `> ${sourcesLine}`,
  ].join("\n");
}

function emitProvenanceLines(briefing: ResearchBriefing): string[] {
  const lines: string[] = [];
  if (briefing.disagreements.length === 0 && briefing.unanswered.length === 0) {
    lines.push("- All channels agreed on the findings above. No disagreements surfaced.");
    return lines;
  }
  for (const d of briefing.disagreements) {
    lines.push(`- ${d}`);
  }
  for (const q of briefing.unanswered) {
    lines.push(`- 1 question went unanswered: "${q}" — flagged for re-run.`);
  }
  return lines;
}

/**
 * Count sources by trust tier — surfaced in the frontmatter blockquote.
 * Exported because the UI uses the same tally for the panel header chip.
 */
export function tallySourceTiers(sources: ReadonlyArray<Source>): {
  primary: number;
  secondary: number;
  tertiary: number;
} {
  let primary = 0;
  let secondary = 0;
  let tertiary = 0;
  for (const s of sources) {
    if (s.trustTier === "primary") primary++;
    else if (s.trustTier === "tertiary") tertiary++;
    else secondary++;
  }
  return { primary, secondary, tertiary };
}
