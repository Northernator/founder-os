/**
 * Distill a venture's chat history + uploaded docs into draft Screens-tab
 * field values.
 *
 * Field schema — text-shaped subset of ScreensCanvas:
 *   notes (top-level free text),
 *   screens[]: { name, description, notes }
 *
 * Skipped on purpose:
 *   - shellType (enum — founder picks deliberately)
 *   - featureIds / entityIds (cross-references to spec — managed in UI)
 *   - id (stable identifier — managed by the canvas)
 *
 * Read-only contract: see `distill-engine.ts`.
 */

import { createDistiller, isSkipSentinel, pickStringField } from "./distill-engine.js";
import { formatSourcesBlock } from "./distill-source.js";

export type DistilledScreen = {
  name: string;
  description?: string;
  notes?: string;
};

export type DistilledScreensFields = {
  notes?: string;
  screens?: DistilledScreen[];
};

export type ScreensCurrentFields = {
  notes: string;
  screens: Array<{ name: string; description: string; notes: string }>;
};

function pickScreens(raw: Record<string, unknown>): DistilledScreen[] | undefined {
  const v = raw.screens;
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const cleaned: DistilledScreen[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { name?: unknown; description?: unknown; notes?: unknown };
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (name.length === 0 || isSkipSentinel(name)) continue;
    const screen: DistilledScreen = { name };
    if (typeof e.description === "string" && !isSkipSentinel(e.description)) {
      screen.description = e.description;
    }
    if (typeof e.notes === "string" && !isSkipSentinel(e.notes)) {
      screen.notes = e.notes;
    }
    cleaned.push(screen);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

export const distillScreens = createDistiller<DistilledScreensFields, ScreensCurrentFields>({
  contextLabel: "screens-distill",
  systemPromptTemplate: ({ sources, currentFields }) => {
    const currentSummary = JSON.stringify(currentFields, null, 2);
    return `You are a product designer. Read evidence — a chat conversation between a founder and an AI assistant about a startup venture, plus any attached documents — and distill it into the free-text fields of a Screens canvas. You must NOT propose shell types, feature mappings, or entity mappings; those are structured decisions the founder makes via dedicated UI controls.

Field schema:
- "notes" (string): Free-text notes about the overall screen architecture or user flow.
- "screens" (object[]): Inventory of screens drawn from the evidence. Each entry is { "name": string, "description": string, "notes": string }.
  - "name": Imperative — "Sign up", "Project list", "Dashboard". Required for the screen to be included.
  - "description": What the user does on this screen, in user terms.
  - "notes": Edge states, empty-state copy hints, responsive behaviour, anything not captured by name+description.

Rules:
- Return raw JSON only. No markdown fences, no preamble, no trailing prose.
- Use the chat transcript and the attached documents as evidence for your drafts. Cite the source (chat or {doc-path}) inside parentheses at the end of any field you draft from a specific source.
- Only include fields where the evidence clearly contains relevant content. Omit unrelated fields entirely (or use the literal string "(no relevant data in chat)" — the caller will filter it).
- Never invent screens. If the evidence does not mention or imply a screen, do not include it.
- For "screens", only include entries with a real name. A screen with no description and no notes is fine if the name itself is informative.
- Do NOT propose shellType, featureIds, or entityIds — those are structured fields the founder maps separately.

Current field values (so you don't regress):
${currentSummary}

${formatSourcesBlock(sources)}`;
  },
  parseDraft: (parsed) => {
    const draft: DistilledScreensFields = {};
    const notes = pickStringField(parsed, "notes");
    if (notes !== undefined) draft.notes = notes;
    const screens = pickScreens(parsed);
    if (screens !== undefined) draft.screens = screens;
    return draft;
  },
});
