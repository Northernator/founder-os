/**
 * Distill a venture's chat history + uploaded docs into draft Research-tab
 * field values.
 *
 * Field schema (mirrors the string fields of ResearchCanvas in
 * features/ventures/ResearchTab.tsx — competitors come back as a list of
 * { name, weakness } pairs the caller can map onto the canvas shape):
 *
 *   marketSummary, tamEstimate, samEstimate, keyMarketGap,
 *   differentiator, topProblems, customerQuotes, evidenceNotes,
 *   researchSummary, goNoGoReason, competitors[]
 *
 * Read-only contract: this distiller never writes to the chat thread.
 * See `distill-engine.ts` for the architectural guarantee.
 *
 * The LLM is told to skip fields with no relevant content (returns
 * "(no relevant data in chat)" or omits the key); we filter those out
 * before handing the draft back to the caller.
 *
 * Failure mode: any error / parse failure resolves to {}. The caller
 * surfaces a toast — the distiller never throws into the UI.
 */

import { createDistiller, pickStringField } from "./distill-engine.js";
import { formatSourcesBlock } from "./distill-source.js";

export type DistilledCompetitor = {
  name: string;
  weakness: string;
};

export type DistilledFields = {
  marketSummary?: string;
  tamEstimate?: string;
  samEstimate?: string;
  keyMarketGap?: string;
  differentiator?: string;
  topProblems?: string;
  customerQuotes?: string;
  evidenceNotes?: string;
  researchSummary?: string;
  goNoGoReason?: string;
  competitors?: DistilledCompetitor[];
};

export type ResearchCurrentFields = {
  marketSummary: string;
  tamEstimate: string;
  samEstimate: string;
  keyMarketGap: string;
  differentiator: string;
  topProblems: string;
  customerQuotes: string;
  evidenceNotes: string;
  researchSummary: string;
  goNoGoReason: string;
  competitors: DistilledCompetitor[];
};

const FIELD_SCHEMA: Record<keyof Omit<DistilledFields, "competitors">, string> = {
  marketSummary: "Description of the market and who the buyers are",
  tamEstimate: "Total Addressable Market estimate (number or range)",
  samEstimate: "Serviceable Addressable Market estimate",
  keyMarketGap: "The unmet need or gap in the market",
  differentiator: "What makes this venture different from competitors",
  topProblems: "Top customer problems validated by research",
  customerQuotes: "Direct customer quotes from interviews, forums, or reviews",
  evidenceNotes: "Summary of validation evidence — numbers, sources, signals",
  researchSummary: "Overall summary of research findings",
  goNoGoReason: "Reasoning behind a go / no-go conclusion (if discussed)",
};

function pickCompetitors(raw: Record<string, unknown>): DistilledCompetitor[] | undefined {
  const v = raw.competitors;
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const cleaned: DistilledCompetitor[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { name?: unknown; weakness?: unknown };
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const weakness = typeof e.weakness === "string" ? e.weakness.trim() : "";
    if (name.length === 0 && weakness.length === 0) continue;
    cleaned.push({ name, weakness });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

export const distillResearch = createDistiller<DistilledFields, ResearchCurrentFields>({
  contextLabel: "research-distill",
  systemPromptTemplate: ({ sources, currentFields }) => {
    const currentSummary = JSON.stringify(currentFields, null, 2);
    return `You are a research analyst. Your task is to read evidence — a chat conversation between a founder and an AI assistant about a startup venture, plus any attached documents — and distill it into structured fields for a Research Canvas.

Field schema (string fields):
${JSON.stringify(FIELD_SCHEMA, null, 2)}

Plus a "competitors" array of objects: [{"name": "...", "weakness": "..."}].

Rules:
- Return raw JSON only. No markdown fences, no preamble, no trailing prose.
- Use the chat transcript and the attached documents as evidence for your drafts. Cite the source (chat or {doc-path}) inside parentheses at the end of any field you draft from a specific source.
- Only include fields where the evidence clearly contains relevant content. Omit unrelated fields entirely (or use the literal string "(no relevant data in chat)" — the caller will filter it).
- Never invent facts. If no source discusses a field, skip it.
- If a field already has a value the user clearly worked on, only propose a draft that *adds* information from the evidence — do not regress to a vaguer version. If your draft would be a regression, omit the field.
- Keep field values concise but substantive — 1–4 sentences for narrative fields. Use plain prose, no bullet markers unless the evidence explicitly enumerates a list.
- For "customerQuotes", preserve quoted speech verbatim where the source contains it.
- For "competitors", only include entries with a real name AND a stated weakness or gap.

Current field values (so you don't regress):
${currentSummary}

${formatSourcesBlock(sources)}`;
  },
  parseDraft: (parsed) => {
    const draft: DistilledFields = {};
    for (const key of Object.keys(FIELD_SCHEMA) as (keyof typeof FIELD_SCHEMA)[]) {
      const v = pickStringField(parsed, key);
      if (v !== undefined) draft[key] = v;
    }
    const comps = pickCompetitors(parsed);
    if (comps !== undefined) draft.competitors = comps;
    return draft;
  },
});
