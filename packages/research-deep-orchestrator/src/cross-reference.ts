/**
 * Cross-referencer — reads N worker partials side-by-side, asks Claude
 * to flag agreements / contradictions / source-quality gaps. Output is
 * annotation that the synthesiser threads into the briefing's
 * `Provenance & disagreements` footer + per-section `llmVerdicts` map.
 *
 * Claude is the canonical cross-referencer per spec §7. The caller can
 * still inject any CallLlm — typically the same one used for the
 * synthesiser.
 *
 * Skipped automatically when only one partial is available (single-
 * channel run); the orchestrator calls this only when `partials.length
 * >= 2`. We re-assert that invariant defensively here so misuse surfaces
 * as a typed error rather than a confusing "Claude said all-agreed".
 */

import {
  ResearchChannelSchema,
  type CallLlm,
  type ChannelVerdict,
  type ProviderPartial,
  type ResearchChannel,
} from "@founder-os/research-deep-core";
import { z } from "zod";
import { CrossReferenceError } from "./errors.js";
import {
  CROSS_REFERENCE_SYSTEM_PROMPT,
  buildCrossReferenceUserPrompt,
} from "./prompts.js";
import { parseLlmJson } from "./util.js";

const CrossReferenceOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      heading: z.string().min(1),
      channel: ResearchChannelSchema,
      agreed: z.boolean(),
      contradicted: z.string().nullable().optional(),
    }),
  ),
  disagreements: z.array(z.string()).default([]),
});

export interface CrossReferenceInput {
  topic: { slug: string; label: string };
  partials: ReadonlyArray<{ channel: ResearchChannel; partial: ProviderPartial }>;
}

export interface CrossReferenceResult {
  /** Free-text disagreement lines for the briefing footer. */
  disagreements: string[];
  /**
   * Per-section verdicts keyed first by heading, then by channel. Slotted
   * into ResearchBriefingSection.llmVerdicts by the synthesiser.
   */
  verdictsByHeading: Map<string, Record<ResearchChannel, ChannelVerdict>>;
  /** Raw LLM response — saved to the transcripts directory by the caller. */
  rawResponse: string;
  /** The parsed JSON, threaded back into the synthesiser prompt. */
  rawJson: unknown;
}

/**
 * Cross-reference the partials. Returns disagreement lines + per-section
 * verdicts ready to slot into ResearchBriefingSection.llmVerdicts. Throws
 * CrossReferenceError on rejection / malformed LLM output — the
 * orchestrator may choose to degrade to "no annotation" rather than fail
 * the whole topic.
 */
export async function crossReference(
  input: CrossReferenceInput,
  opts: { callLlm: CallLlm },
): Promise<CrossReferenceResult> {
  if (input.partials.length < 2) {
    throw new CrossReferenceError(
      `cross-reference requires >= 2 partials, got ${input.partials.length}`,
    );
  }

  const user = buildCrossReferenceUserPrompt(input);

  let response: string;
  try {
    response = await opts.callLlm({
      system: CROSS_REFERENCE_SYSTEM_PROMPT,
      user,
    });
  } catch (err) {
    throw new CrossReferenceError("callLlm rejected", err);
  }

  if (!response || !response.trim()) {
    throw new CrossReferenceError("empty response from callLlm");
  }

  let parsed: unknown;
  try {
    parsed = parseLlmJson(response);
  } catch (err) {
    throw new CrossReferenceError("JSON parse failed", err);
  }

  let validated: z.infer<typeof CrossReferenceOutputSchema>;
  try {
    validated = CrossReferenceOutputSchema.parse(parsed);
  } catch (err) {
    throw new CrossReferenceError("schema validation failed", err);
  }

  const verdictsByHeading = new Map<
    string,
    Record<ResearchChannel, ChannelVerdict>
  >();
  for (const v of validated.verdicts) {
    const existing = verdictsByHeading.get(v.heading) ??
      ({} as Record<ResearchChannel, ChannelVerdict>);
    const verdict: ChannelVerdict = {
      agreed: v.agreed,
      addedSources: [],
      ...(v.contradicted && v.contradicted.trim().length > 0
        ? { contradicted: v.contradicted.trim() }
        : {}),
    };
    existing[v.channel] = verdict;
    verdictsByHeading.set(v.heading, existing);
  }

  return {
    disagreements: validated.disagreements,
    verdictsByHeading,
    rawResponse: response,
    rawJson: parsed,
  };
}
