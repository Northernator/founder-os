/**
 * Distill engine — single helper every per-tab distiller is built on.
 *
 * READ-ONLY CONTRACT
 * ──────────────────
 * A distiller may NEVER mutate the chat thread. The engine reads the
 * (ventureId, stage) thread from the DB via `gatherDistillSources` and
 * issues a transient one-shot LLM call. It does not call
 * `db.insertChatMessage`, `db.clearChatThread`, or any other chat-write
 * primitive. `streamChat` itself is non-persisting — chat persistence
 * lives only in `VentureDashboard.handleSend`.
 *
 * This contract is what fixes the "distill clears the chat thread" bug:
 * regardless of how a future tab wires its distiller, going through this
 * engine guarantees the chat is treated as evidence, not as state.
 *
 * Each per-tab distiller (research-distiller, validation-distiller,
 * brand-distiller, …) is a thin call to `createDistiller` with a
 * field-shape-specific systemPromptTemplate + parseDraft. Defensive JSON
 * parsing happens here once, not duplicated per file.
 */

import type { VentureStage } from "@founder-os/domain";
import { type PromptContext, optimize } from "@founder-os/prompt-master";
import { type DistillSources, gatherDistillSources } from "./distill-source.js";
import { pickActiveProvider, streamChat } from "./llm-client.js";

const DEFAULT_SKIP_SENTINELS: ReadonlySet<string> = new Set([
  "(no relevant data in chat)",
  "(no relevant data)",
  "(no relevant data in sources)",
  "(none)",
  "n/a",
  "null",
]);

/** True if `value` is empty / sentinel / one of the caller-provided skips. */
export function isSkipSentinel(value: string, extraSentinels: readonly string[] = []): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return true;
  if (DEFAULT_SKIP_SENTINELS.has(v)) return true;
  for (const s of extraSentinels) {
    if (v === s.trim().toLowerCase()) return true;
  }
  return false;
}

/** Pull a string field, dropping sentinels. Returns undefined when the
 *  value is absent / wrong type / a skip sentinel. */
export function pickStringField(
  raw: Record<string, unknown>,
  key: string,
  extraSentinels: readonly string[] = []
): string | undefined {
  const v = raw[key];
  if (typeof v !== "string") return undefined;
  if (isSkipSentinel(v, extraSentinels)) return undefined;
  return v;
}

/** Pull a string-array field, dropping sentinel/empty entries. Returns
 *  undefined when the array is absent or every entry was filtered. */
export function pickStringArray(
  raw: Record<string, unknown>,
  key: string,
  extraSentinels: readonly string[] = []
): string[] | undefined {
  const v = raw[key];
  if (!Array.isArray(v)) return undefined;
  const cleaned: string[] = [];
  for (const e of v) {
    if (typeof e !== "string") continue;
    if (isSkipSentinel(e, extraSentinels)) continue;
    cleaned.push(e.trim());
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Strip a fenced JSON block or any leading/trailing prose around the
 *  first `{ … }`. Returns the candidate JSON text — the caller still has
 *  to JSON.parse and try/catch. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  // ```json … ```  or  ``` … ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Sometimes the model wraps prose around a JSON object. Grab the first
  // {…} block. Loose by design — JSON.parse below catches malformed tail.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return trimmed;
}

export type DistillerInput<F> = {
  ventureId: string;
  stage: VentureStage;
  ventureRootPath: string;
  currentFields: F;
};

export type DistillerConfig<T extends Record<string, unknown>, F = unknown> = {
  /** Telemetry tag — surfaces in the Options-tab "Top Contexts" list. */
  contextLabel: PromptContext;
  /** Build the system prompt from gathered sources + current fields. */
  systemPromptTemplate: (input: { sources: DistillSources; currentFields: F }) => string;
  /** Map the parsed JSON object onto a typed Partial<T>. Filter sentinels
   *  here — the engine doesn't know the field schema. */
  parseDraft: (parsed: Record<string, unknown>) => Partial<T>;
};

/**
 * Build a per-tab distiller bound to a single PromptContext + field schema.
 *
 * Read-only contract: the returned function gathers chat + docs from disk
 * and issues a transient LLM call. It NEVER appends to the chat thread
 * (does not call insertChatMessage), and NEVER deletes from it (does not
 * call clearChatThread). The only persistence side-effect is the
 * Prompt-Master telemetry event written by `optimize`.
 */
export function createDistiller<T extends Record<string, unknown>, F = unknown>(
  config: DistillerConfig<T, F>
): (input: DistillerInput<F>) => Promise<Partial<T>> {
  return async function runDistiller(input: DistillerInput<F>): Promise<Partial<T>> {
    const sources = await gatherDistillSources({
      ventureId: input.ventureId,
      stage: input.stage,
      ventureRootPath: input.ventureRootPath,
    });
    if (sources.chatTranscript.trim().length === 0 && sources.docExcerpts.length === 0) {
      return {};
    }

    const provider = await pickActiveProvider(input.ventureId);
    if (!provider) {
      throw new Error("No AI provider configured");
    }

    const systemPrompt = config.systemPromptTemplate({
      sources,
      currentFields: input.currentFields,
    });

    const optimized = await optimize({
      prompt: systemPrompt,
      context: config.contextLabel,
      ventureId: input.ventureId,
    });
    console.info(
      `[prompt-master] ${config.contextLabel}`,
      optimized.fallbackUsed
        ? "(fallback — transport unavailable)"
        : `tokensSaved=${optimized.tokensSaved} cacheHit=${optimized.cacheHit}`
    );

    let responseText = "";
    // Distill is read-only against the chat. Never appends, never deletes.
    // streamChat does not persist — chat-write happens only in
    // VentureDashboard.handleSend. We pass an in-memory user turn here
    // purely to satisfy the provider request shape.
    await streamChat({
      provider,
      system: optimized.optimized,
      messages: [
        {
          role: "user",
          content:
            "Distill the chat transcript and any attached documents into the field schema described in the system prompt. Return JSON only.",
        },
      ],
      maxTokens: 2000,
      temperature: 0.1,
      onDelta: (d) => {
        responseText += d;
      },
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripCodeFences(responseText)) as Record<string, unknown>;
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object") return {};
    return config.parseDraft(parsed);
  };
}
