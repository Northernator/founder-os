/**
 * Distill a venture's chat history + uploaded docs into draft Brand-tab
 * field values.
 *
 * Field schema — text-shaped subset of BrandCanvas:
 *   tagline, mission, targetAudience, toneOfVoice, notes,
 *   competitors[], differentiators[]
 *
 * Skipped on purpose:
 *   - palette (color tokens — visual decision)
 *   - typography (font selection — visual decision)
 *   - personality (enum array — founder picks deliberately)
 *
 * Read-only contract: see `distill-engine.ts`.
 */

import { createDistiller, pickStringArray, pickStringField } from "./distill-engine.js";
import { formatSourcesBlock } from "./distill-source.js";

export type DistilledBrandFields = {
  tagline?: string;
  mission?: string;
  targetAudience?: string;
  toneOfVoice?: string;
  notes?: string;
  competitors?: string[];
  differentiators?: string[];
};

export type BrandCurrentFields = {
  tagline: string;
  mission: string;
  targetAudience: string;
  toneOfVoice: string;
  notes: string;
  competitors: string[];
  differentiators: string[];
};

const STRING_FIELD_SCHEMA: Record<
  Exclude<keyof DistilledBrandFields, "competitors" | "differentiators">,
  string
> = {
  tagline: "Short marketing tagline — one line, evocative",
  mission: "Mission statement — what the company exists to do, in 1–2 sentences",
  targetAudience: "Who the brand is speaking to — the primary audience description",
  toneOfVoice:
    "Tone of voice description — how the brand should sound (warm / direct / playful / …)",
  notes: "Any free-form designer notes the founder wants captured for later",
};

export const distillBrand = createDistiller<DistilledBrandFields, BrandCurrentFields>({
  contextLabel: "brand-distill",
  systemPromptTemplate: ({ sources, currentFields }) => {
    const currentSummary = JSON.stringify(currentFields, null, 2);
    return `You are a brand strategist. Read evidence — a chat conversation between a founder and an AI assistant about a startup venture, plus any attached documents — and distill it into structured TEXT fields for a Brand canvas. You must NOT propose colors, typography, or personality enum values; those are deliberate visual decisions the founder makes elsewhere.

Field schema (string fields):
${JSON.stringify(STRING_FIELD_SCHEMA, null, 2)}

Plus two string-array fields:
- "competitors": brand competitors mentioned in the evidence (names only, not weaknesses).
- "differentiators": short phrases describing what makes this brand different.

Rules:
- Return raw JSON only. No markdown fences, no preamble, no trailing prose.
- Use the chat transcript and the attached documents as evidence for your drafts. Cite the source (chat or {doc-path}) inside parentheses at the end of any field you draft from a specific source.
- Only include fields where the evidence clearly contains relevant content. Omit unrelated fields entirely (or use the literal string "(no relevant data in chat)" — the caller will filter it).
- Never invent facts. If no source discusses a field, skip it.
- If a field already has a value the user clearly worked on, only propose a draft that *adds* information from the evidence — do not regress to a vaguer version. If your draft would be a regression, omit the field.
- "tagline" should be at most 10 words. "mission" should be 1–2 sentences. "toneOfVoice" should be a short phrase or sentence.
- Do NOT propose personality (e.g. "bold", "minimal"), color palettes, or font choices.

Current field values (so you don't regress):
${currentSummary}

${formatSourcesBlock(sources)}`;
  },
  parseDraft: (parsed) => {
    const draft: DistilledBrandFields = {};
    for (const key of Object.keys(STRING_FIELD_SCHEMA) as (keyof typeof STRING_FIELD_SCHEMA)[]) {
      const v = pickStringField(parsed, key);
      if (v !== undefined) draft[key] = v;
    }
    const comps = pickStringArray(parsed, "competitors");
    if (comps !== undefined) draft.competitors = comps;
    const diffs = pickStringArray(parsed, "differentiators");
    if (diffs !== undefined) draft.differentiators = diffs;
    return draft;
  },
});
