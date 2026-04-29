/**
 * Distill a venture's chat history + uploaded docs into draft Validation-tab
 * field values.
 *
 * Field schema (mirrors the editable fields of ValidationCanvas in
 * features/ventures/ValidationTab.tsx — every field below is a string with
 * a `""` default; `experiments[]` and the `validationDecision` enum are
 * intentionally NOT distilled here:
 *   - experiments: structured rows with a custom add/edit UI; the founder
 *     builds these themselves so status/result stay honest.
 *   - validationDecision: gated enum the founder explicitly chooses.
 *
 *   icpDescription, icpRole, icpPain, icpCurrentSolution, icpTrigger,
 *   valueProposition, whatsIncluded, whatsExcluded,
 *   pricePoint, pricingModel, priceSensitivityNotes,
 *   keyLearnings, whatChanged, decisionReason
 *
 * Read-only contract: this distiller never writes to the chat thread.
 * See `distill-engine.ts` for the architectural guarantee.
 *
 * Failure mode: any error / parse failure resolves to {}. The caller
 * surfaces a toast — the distiller never throws into the UI.
 */

import { createDistiller, pickStringField } from "./distill-engine.js";
import { formatSourcesBlock } from "./distill-source.js";

export type DistilledValidationFields = {
  icpDescription?: string;
  icpRole?: string;
  icpPain?: string;
  icpCurrentSolution?: string;
  icpTrigger?: string;
  valueProposition?: string;
  whatsIncluded?: string;
  whatsExcluded?: string;
  pricePoint?: string;
  pricingModel?: string;
  priceSensitivityNotes?: string;
  keyLearnings?: string;
  whatChanged?: string;
  decisionReason?: string;
};

export type ValidationCurrentFields = Required<DistilledValidationFields>;

const FIELD_SCHEMA: Record<keyof DistilledValidationFields, string> = {
  icpDescription:
    "Full description of the ideal customer (demographics, situation, context — one specific person)",
  icpRole: "Job title or role of the ideal customer",
  icpPain: "Their #1 pain point — ideally in their own words",
  icpCurrentSolution: "What they currently use or do to solve the problem today",
  icpTrigger: "What event triggers them to look for a new solution",
  valueProposition: "One-sentence value proposition (We help [ICP] to [outcome] without [pain])",
  whatsIncluded: "Features or capabilities included in v1 of the offer",
  whatsExcluded: "Explicitly cut features — what is NOT in v1",
  pricePoint: "Proposed price point (number + currency + frequency)",
  pricingModel: "How the pricing is structured (subscription, one-off, usage-based, etc.)",
  priceSensitivityNotes:
    "What prospects said about price — willingness-to-pay signals, ceilings, push-back",
  keyLearnings: "Key learnings from interviews / experiments — surprises, confirmations, doubts",
  whatChanged: "What changed from the original assumptions — ICP shifts, scope changes, pivots",
  decisionReason:
    "Reasoning behind the validation decision (validated / pivot / invalidated) — only if discussed",
};

export const distillValidation = createDistiller<DistilledValidationFields, ValidationCurrentFields>(
  {
    contextLabel: "validation-distill",
    systemPromptTemplate: ({ sources, currentFields }) => {
      const currentSummary = JSON.stringify(currentFields, null, 2);
      return `You are a validation analyst. Your task is to read evidence — a chat conversation between a founder and an AI assistant about a startup venture, plus any attached documents — and distill it into structured fields for a Validation Canvas (ICP, offer, pricing, results).

Field schema (all string fields):
${JSON.stringify(FIELD_SCHEMA, null, 2)}

Rules:
- Return raw JSON only. No markdown fences, no preamble, no trailing prose.
- Use the chat transcript and the attached documents as evidence for your drafts. Cite the source (chat or {doc-path}) inside parentheses at the end of any field you draft from a specific source.
- Only include fields where the evidence clearly contains relevant content. Omit unrelated fields entirely (or use the literal string "(no relevant data in chat)" — the caller will filter it).
- Never invent facts. If no source discusses a field, skip it.
- If a field already has a value the user clearly worked on, only propose a draft that *adds* information from the evidence — do not regress to a vaguer version. If your draft would be a regression, omit the field.
- Keep field values concise but substantive — 1–4 sentences for narrative fields, a short phrase for pricePoint / icpRole. Use plain prose.
- For "icpPain", preserve quoted speech verbatim where the source contains it.
- Do NOT propose a validationDecision (validated/pivot/invalidated) — only the founder makes that call.
- Do NOT propose individual experiments — those live in a separate structured list.

Current field values (so you don't regress):
${currentSummary}

${formatSourcesBlock(sources)}`;
    },
    parseDraft: (parsed) => {
      const draft: DistilledValidationFields = {};
      for (const key of Object.keys(FIELD_SCHEMA) as (keyof DistilledValidationFields)[]) {
        const v = pickStringField(parsed, key);
        if (v !== undefined) draft[key] = v;
      }
      return draft;
    },
  }
);
