/**
 * BantAgent -- scores prospect on Budget / Authority / Need / Timeline.
 *
 * Reads the research slice from memory; returns 1-5 per dimension plus a
 * 0-100 fitScore (avg * 20, rounded). A low score is a valid output.
 *
 * If research is missing or empty the agent still runs but the LLM has
 * less to score against -- partial-run output remains useful, just less
 * grounded.
 */

import { BaseAgent } from "../agent-base.js";
import type { AgentInput, BantSlice } from "../types.js";

const SYSTEM_PROMPT = `You are a B2B sales qualification expert. Score the
prospect on BANT (1-5 each):
 - Budget: estimated budget for our solution
 - Authority: ease of finding decision makers
 - Need: urgency / fit for our product
 - Timeline: realistic purchase timeline

Be realistic. A low score is valuable -- it lets us deprioritise unfit deals.

Return ONLY valid JSON:
{ "scores": { "budget": 1-5, "authority": 1-5, "need": 1-5, "timeline": 1-5 },
  "reasoning": "2-4 sentences explaining the scores" }`;

export class BantAgent extends BaseAgent {
  readonly name = "BantAgent";

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const memory = await this.loadMemory(input.fs, input.memoryPath);
    const research = memory.research?.company ?? {};

    const userPrompt = `Score this prospect on BANT criteria.\n\nCompany research:\n${JSON.stringify(research, null, 2)}\n\nBe honest -- under-score rather than over-score when uncertain.`;

    const parsed = await this.callJson<{
      scores: BantSlice["scores"];
      reasoning: string;
    }>(input.callLlm, SYSTEM_PROMPT, userPrompt);

    const scores = parsed.scores ?? { budget: 0, authority: 0, need: 0, timeline: 0 };
    const sum = scores.budget + scores.authority + scores.need + scores.timeline;
    const fitScore = Math.round((sum / 4) * 20);

    const slice: BantSlice = {
      scores,
      fitScore,
      reasoning: parsed.reasoning ?? "",
      timestamp: new Date().toISOString(),
    };

    return slice as unknown as Record<string, unknown>;
  }
}
