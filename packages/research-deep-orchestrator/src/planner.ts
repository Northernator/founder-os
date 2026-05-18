/**
 * Planner — produces a list of ResearchQuestion[] for a single topic
 * given the topic label + venture context. Spec §7 names Claude as the
 * planner; this module accepts any CallLlm so the host can wire whichever
 * subscription / API transport, with a fallback chain when the primary
 * channel rejects.
 *
 * Output: a validated ResearchQuestion[] ready to hand to the worker pool.
 * Failure: a PlannerError with the cause attached, after every fallback
 * has been tried.
 */

import {
  ResearchQuestionSchema,
  type CallLlm,
  type ResearchQuestion,
} from "@founder-os/research-deep-core";
import { z } from "zod";
import { PlannerError } from "./errors.js";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
} from "./prompts.js";
import { parseLlmJson } from "./util.js";

const PlannerOutputSchema = z.object({
  questions: z.array(ResearchQuestionSchema).min(1).max(20),
});

export interface PlannerInput {
  topic: { slug: string; label: string };
  ventureContext: string;
  /**
   * Optional seed questions the stage runner wants to ensure get asked.
   * The planner refines / supplements these rather than discarding them.
   */
  seedQuestions?: ReadonlyArray<ResearchQuestion>;
}

export interface PlannerResult {
  questions: ResearchQuestion[];
  /** Which CallLlm in the chain actually succeeded (0 = primary). */
  fallbackIndex: number;
  /** Raw response from the successful caller — saved for transcripts. */
  rawResponse: string;
}

export interface PlanTopicOpts {
  /**
   * Ordered list of LLM callers. Index 0 is the primary (claude-sub on
   * the host side). The planner tries each in turn until one returns a
   * parseable response; throws PlannerError only if all reject.
   */
  callLlmChain: ReadonlyArray<CallLlm>;
}

/**
 * Plan one topic — ask the primary CallLlm to emit a ResearchQuestion[],
 * fall through the chain on rejection / parse failure.
 *
 * The planner deliberately treats a malformed JSON response the same as a
 * thrown rejection: both indicate the channel isn't behaving and we should
 * try the next one. The last channel's failure is the one surfaced.
 */
export async function planTopic(
  input: PlannerInput,
  opts: PlanTopicOpts,
): Promise<PlannerResult> {
  if (opts.callLlmChain.length === 0) {
    throw new PlannerError("callLlmChain is empty");
  }

  const user = buildPlannerUserPrompt(input);
  let lastFailure: unknown;

  for (let i = 0; i < opts.callLlmChain.length; i++) {
    const caller = opts.callLlmChain[i];
    if (!caller) continue;
    try {
      const response = await caller({
        system: PLANNER_SYSTEM_PROMPT,
        user,
      });
      if (!response || !response.trim()) {
        lastFailure = new Error("empty response from planner LLM");
        continue;
      }
      const parsed = parseLlmJson<unknown>(response);
      const validated = PlannerOutputSchema.parse(parsed);
      // De-duplicate by id — Claude occasionally repeats an id between a
      // seed and a refinement; pick the last occurrence (refinement wins).
      const byId = new Map<string, ResearchQuestion>();
      for (const q of validated.questions) byId.set(q.id, q);
      return {
        questions: [...byId.values()],
        fallbackIndex: i,
        rawResponse: response,
      };
    } catch (err) {
      lastFailure = err;
      // Loop continues — try the next caller.
    }
  }

  throw new PlannerError(
    "all caller channels rejected or returned malformed output",
    lastFailure,
  );
}
