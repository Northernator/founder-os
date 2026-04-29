/**
 * Distill a venture's chat history + uploaded docs into draft Spec-tab
 * field values.
 *
 * Field schema — text-shaped subset of ProductSpecCanvas:
 *   purpose (string), inScope (string[]), outOfScope (string[]),
 *   notes (string)
 *
 * Skipped on purpose:
 *   - personas, features, dataModel, apiSurface, nonFunctional,
 *     metrics: those are highly structured and have a dedicated AI
 *     drafter (`spec-drafter.ts`). Distill targets only the free-text
 *     fields the founder edits directly in big textareas.
 *   - ventureId, version, createdAt, updatedAt: managed by the canvas.
 *
 * Read-only contract: see `distill-engine.ts`.
 */

import { createDistiller, pickStringArray, pickStringField } from "./distill-engine.js";
import { formatSourcesBlock } from "./distill-source.js";

export type DistilledSpecFields = {
  purpose?: string;
  inScope?: string[];
  outOfScope?: string[];
  notes?: string;
};

export type SpecCurrentFields = {
  purpose: string;
  inScope: string[];
  outOfScope: string[];
  notes: string;
};

export const distillSpec = createDistiller<DistilledSpecFields, SpecCurrentFields>({
  contextLabel: "spec-distill",
  systemPromptTemplate: ({ sources, currentFields }) => {
    const currentSummary = JSON.stringify(currentFields, null, 2);
    return `You are a product spec analyst. Read evidence — a chat conversation between a founder and an AI assistant about a startup venture, plus any attached documents — and distill it into the free-text fields of a Product Spec canvas. You must NOT propose personas, features, data model entities, API endpoints, NFRs, or metrics; those are structured rows the founder edits via dedicated UI (or drafts via the separate Spec drafter).

Field schema:
- "purpose" (string): One-paragraph product purpose statement — what this product does, for whom, and why it matters.
- "inScope" (string[]): Concrete capabilities v1 will ship with. May be cross-cutting ("works on mobile web", "exports to CSV") rather than a single named feature.
- "outOfScope" (string[]): Explicit "we are NOT building" statements — deferred or excluded ideas.
- "notes" (string): Free-text notes that don't fit the structured fields.

Rules:
- Return raw JSON only. No markdown fences, no preamble, no trailing prose.
- Use the chat transcript and the attached documents as evidence for your drafts. Cite the source (chat or {doc-path}) inside parentheses at the end of any field you draft from a specific source.
- Only include fields where the evidence clearly contains relevant content. Omit unrelated fields entirely (or use the literal string "(no relevant data in chat)" — the caller will filter it).
- Never invent facts. If no source discusses a field, skip it.
- If a field already has a value the user clearly worked on, only propose a draft that *adds* information from the evidence — do not regress to a vaguer version. If your draft would be a regression, omit the field.
- Keep "purpose" to 2–4 sentences. "inScope" / "outOfScope" entries should each be a short phrase (one line).
- Do NOT propose personas, features, entities, endpoints, NFRs, or metrics — those go through a different drafter.

Current field values (so you don't regress):
${currentSummary}

${formatSourcesBlock(sources)}`;
  },
  parseDraft: (parsed) => {
    const draft: DistilledSpecFields = {};
    const purpose = pickStringField(parsed, "purpose");
    if (purpose !== undefined) draft.purpose = purpose;
    const notes = pickStringField(parsed, "notes");
    if (notes !== undefined) draft.notes = notes;
    const inScope = pickStringArray(parsed, "inScope");
    if (inScope !== undefined) draft.inScope = inScope;
    const outOfScope = pickStringArray(parsed, "outOfScope");
    if (outOfScope !== undefined) draft.outOfScope = outOfScope;
    return draft;
  },
});
